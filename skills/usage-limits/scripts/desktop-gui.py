#!/usr/bin/env python3
"""GTK front end for the local quota report and complete-window measurements."""

import datetime
import json
import pathlib
import shutil
import subprocess
import threading

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, Gio, GLib, Gtk, Pango

ROOT = pathlib.Path(__file__).resolve().parents[3]
ACTIVE = {'armed', 'waiting-window', 'running'}
PHASES = {'armed': '等待下次清零', 'waiting-window': '已记录 0%，等待新周期',
          'running': '正在测量', 'completed': '测量已完成', 'stopped': '已手动结束', 'expired': '周期已结束'}
REASONS = {'five-hour-rejection': '首次 5h 限额拒绝，已自动封存', 'meter-full': '首次观察到 100% 的额度快照',
           'cycle-ended': '周期自然结束，未观察到跑满', 'manual-stop': '手动结束，记录部分消耗', 'cancelled': '已取消等待'}
CSS = b'''
window { background: #f5f7fb; color: #172b4d; }
headerbar { background: #ffffff; border-bottom: 1px solid #e4e9f1; }
notebook > header { background: #f5f7fb; border: none; }
notebook > header tab { padding: 10px 20px; }
.card { background: #ffffff; border: 1px solid #e4e9f1; border-radius: 12px; padding: 20px; }
.card-title { font-size: 17px; font-weight: bold; }
.hero { font-size: 34px; font-weight: bold; color: #1d4ed8; }
.metric { font-size: 20px; font-weight: bold; }
.muted { color: #64748b; font-size: 12px; }
.sample { color: #475569; font-size: 12px; }
.banner { border-radius: 8px; padding: 12px 16px; background: #eaf2ff; color: #1e40af; }
.warning { background: #fff4dc; color: #92400e; }
.primary { background: #2563eb; color: white; border: 1px solid #2563eb; border-radius: 6px; padding: 8px 14px; }
.primary:disabled { background: #e2e8f0; color: #7c8ba1; border-color: #e2e8f0; }
.secondary { border-radius: 6px; padding: 8px 14px; }
progressbar trough { min-height: 7px; border-radius: 6px; background: #e9eef6; border: none; }
progressbar progress { min-height: 7px; border-radius: 6px; background: #3b82f6; border: none; }
treeview { background: white; color: #172b4d; }
'''


def money(value):
    return f'${value:,.2f}' if isinstance(value, (int, float)) else '待采样'


def number(value):
    return f'{int(value or 0):,}'


def clock(value, full=False):
    if not isinstance(value, (int, float)):
        return '—'
    return datetime.datetime.fromtimestamp(value / 1000).strftime('%m-%d %H:%M:%S' if full else '%H:%M:%S')


def label(text='', style=None, wrap=False):
    widget = Gtk.Label(label=text, xalign=0)
    widget.set_line_wrap(wrap)
    if style:
        widget.get_style_context().add_class(style)
    return widget


def card():
    widget = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    widget.get_style_context().add_class('card')
    return widget


def table(columns):
    store = Gtk.ListStore(*([str] * len(columns)))
    view = Gtk.TreeView(model=store)
    view.set_headers_visible(True)
    for index, name in enumerate(columns):
        renderer = Gtk.CellRendererText()
        renderer.set_property('ellipsize', Pango.EllipsizeMode.END)
        column = Gtk.TreeViewColumn(name, renderer, text=index)
        column.set_resizable(True)
        column.set_expand(index == 0)
        view.append_column(column)
    scroll = Gtk.ScrolledWindow()
    scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
    scroll.set_min_content_height(145)
    scroll.add(view)
    return store, scroll


class QuotaCard(Gtk.Box):
    def __init__(self, title):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        self.get_style_context().add_class('card')
        head = Gtk.Box(spacing=12)
        head.pack_start(label(title, 'card-title'), True, True, 0)
        self.percent = label('—', 'metric')
        head.pack_end(self.percent, False, False, 0)
        self.pack_start(head, False, False, 0)
        self.pack_start(label('预计整段 API 等价价值', 'muted'), False, False, 0)
        self.total = label('待采样', 'hero')
        self.pack_start(self.total, False, False, 0)
        self.bar = Gtk.ProgressBar()
        self.pack_start(self.bar, False, False, 0)
        grid = Gtk.Grid(column_spacing=30, row_spacing=5)
        self.spent_caption = label('本周期 API 等价已用', 'muted')
        grid.attach(self.spent_caption, 0, 0, 1, 1)
        grid.attach(label('快照时预计剩余', 'muted'), 1, 0, 1, 1)
        self.spent, self.remaining = label('—', 'metric'), label('—', 'metric')
        grid.attach(self.spent, 0, 1, 1, 1)
        grid.attach(self.remaining, 1, 1, 1, 1)
        self.pack_start(grid, False, False, 0)
        self.tokens = label('本周期 token：—')
        self.period = label('', 'muted', True)
        self.status = label('', 'sample', True)
        self.sample = label('', 'muted', True)
        for widget in [self.tokens, self.period, self.status, self.sample]:
            self.pack_start(widget, False, False, 0)

    def update(self, row):
        percent = row.get('percentUsed')
        self.percent.set_text(f'{percent:g}%' if isinstance(percent, (int, float)) else '未知')
        self.bar.set_fraction(max(0, min(1, (percent or 0) / 100)))
        self.total.set_text(money(row.get('totalUSD')))
        self.spent.set_text(money(row.get('spentUSD')) + (' *' if row.get('unknownModels') else ''))
        self.remaining.set_text(money(row.get('remainingUSD')))
        anchored = row.get('resetsAt') is not None
        scope = '本周期' if anchored else '最近本地日志'
        self.spent_caption.set_text(scope + ' API 等价费用')
        self.tokens.set_text(scope + ' token：' + number(row.get('spentTokens')))
        self.period.set_text('服务端重置时间 · ' + clock(row['resetsAt'], True) if anchored else '服务端尚未返回新周期的时间边界')
        self.status.set_text(row.get('statusText', '等待额度与日志'))
        sample = row.get('sample')
        if sample:
            method = '区间校准' if sample['method'] == 'observed-delta' else '周期累计估计'
            self.sample.set_text(f"{method} · {sample['points']:g} 个百分点 · {sample['calls']} 次调用\n采样于 {clock(sample['at'])}")
        else:
            self.sample.set_text('累计估计假设本机日志覆盖全部消耗；完整测量请使用“从 0 开始测量”。')


class Window(Gtk.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title='Claude 额度价值')
        self.set_icon_name('utilities-system-monitor')
        self.set_default_size(1060, 860)
        self.set_size_request(880, 650)
        self.busy, self.closed, self.last_data = False, False, None
        self.first_load = True
        self.connect('delete-event', self.closing)
        self.connect('key-press-event', self.keypress)
        header = Gtk.HeaderBar(title='Claude 额度价值', subtitle='订阅额度的 API 等价价值与完整测量')
        header.set_show_close_button(True)
        self.set_titlebar(header)
        self.spinner = Gtk.Spinner()
        header.pack_end(self.spinner)
        self.refresh_button = Gtk.Button.new_with_label('立即刷新')
        self.refresh_button.get_style_context().add_class('primary')
        self.refresh_button.connect('clicked', lambda _: self.request('--refresh'))
        header.pack_end(self.refresh_button)
        self.export_button = Gtk.Button.new_with_label('导出记录')
        self.export_button.connect('clicked', self.export)
        self.export_button.set_sensitive(False)
        header.pack_end(self.export_button)
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, margin=18)
        self.add(outer)
        self.banner = label('正在读取本机额度与用量…', 'banner', True)
        outer.pack_start(self.banner, False, False, 0)
        self.notebook = Gtk.Notebook()
        outer.pack_start(self.notebook, True, True, 0)
        self.build_overview()
        self.build_measurement()
        self.build_history()
        self.footer = label('美元均为 API 等价价值，不是额外账单。统计仅覆盖本机日志。', 'muted', True)
        outer.pack_end(self.footer, False, False, 0)
        GLib.timeout_add_seconds(60, self.tick)
        GLib.idle_add(self.request)

    def page(self, title):
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16, margin_top=16, margin_bottom=8)
        scroll.add(box)
        self.notebook.append_page(scroll, label(title))
        return box

    def build_overview(self):
        box = self.page('额度总览')
        cards = Gtk.Box(spacing=16, homogeneous=True)
        self.five, self.week = QuotaCard('5 小时额度'), QuotaCard('每周额度')
        cards.pack_start(self.five, True, True, 0)
        cards.pack_start(self.week, True, True, 0)
        box.pack_start(cards, False, False, 0)
        expander = Gtk.Expander(label='查看 token 与模型明细')
        self.models, scroll = table(['窗口 / 模型', '输入', '缓存写入', '缓存读取', '输出', 'API 等价费用'])
        expander.add(scroll)
        box.pack_start(expander, False, False, 0)
        info = card()
        info.pack_start(label('想知道完整 5h 到底值多少？', 'card-title'), False, False, 0)
        info.pack_start(label('选择“完整测量”，从真实 0% 开始记录。观察到首次 5h 限额或 100% 快照时，会自动保存本轮费用。', None, True), False, False, 0)
        button = Gtk.Button.new_with_label('查看完整测量 →')
        button.set_halign(Gtk.Align.START)
        button.connect('clicked', lambda _: self.notebook.set_current_page(1))
        info.pack_start(button, False, False, 0)
        box.pack_start(info, False, False, 0)

    def build_measurement(self):
        box = self.page('完整测量')
        panel = card()
        self.measure_title = label('从 0 到首次 5h 限额', 'card-title')
        panel.pack_start(self.measure_title, False, False, 0)
        self.measure_status = label('尚未开始测量', 'banner', True)
        panel.pack_start(self.measure_status, False, False, 0)
        values = Gtk.Box(spacing=45, homogeneous=True)
        self.measured_cost, self.measured_tokens, self.measured_percent = label('—', 'hero'), label('—', 'metric'), label('—', 'metric')
        for caption, widget in [('本轮实测 API 等价消耗', self.measured_cost), ('本轮累计 token', self.measured_tokens), ('最近的 5h 读数', self.measured_percent)]:
            column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
            column.pack_start(label(caption, 'muted'), False, False, 0)
            column.pack_start(widget, False, False, 0)
            values.pack_start(column, True, True, 0)
        panel.pack_start(values, False, False, 6)
        self.measure_times = label('', 'sample', True)
        self.measure_detail = label('', 'sample', True)
        panel.pack_start(self.measure_times, False, False, 0)
        panel.pack_start(self.measure_detail, False, False, 0)
        buttons = Gtk.Box(spacing=12)
        self.start_button = Gtk.Button.new_with_label('从 0% 开始测量')
        self.start_button.get_style_context().add_class('primary')
        self.start_button.connect('clicked', lambda _: self.request('--measure-start'))
        self.stop_button = Gtk.Button.new_with_label('结束并保存')
        self.stop_button.get_style_context().add_class('secondary')
        self.stop_button.connect('clicked', lambda _: self.request('--measure-stop'))
        buttons.pack_start(self.start_button, False, False, 0)
        buttons.pack_start(self.stop_button, False, False, 0)
        panel.pack_start(buttons, False, False, 6)
        panel.pack_start(label('当前不是 0% 时，会等待下一次清零。关闭窗口后，已安装的后台采样仍会继续。\n手动结束保存的是部分消耗，不会当作完整额度。', 'muted', True), False, False, 0)
        box.pack_start(panel, False, False, 0)
        info = card()
        info.pack_start(label('测量怎样完成？', 'card-title'), False, False, 0)
        info.pack_start(label('1. 点击开始，等待真实 0% 读数。\n2. 正常使用 Claude Code，本轮单独累计 token 和费用。\n3. 首次出现 5h 限额拒绝或额度达到 100%，自动保存结果。\n\n以 100% 快照结束时，会标明截止依据；完整结果可在历史记录中查看、导出。', 'sample', True), False, False, 0)
        box.pack_start(info, False, False, 0)

    def build_history(self):
        box = self.page('历史记录')
        panel = card()
        panel.pack_start(label('完整测量记录', 'card-title'), False, False, 0)
        self.measure_history, scroll = table(['开始时间', '状态 / 截止依据', '累计 token', 'API 等价消耗'])
        panel.pack_start(scroll, True, True, 0)
        box.pack_start(panel, True, True, 0)
        panel = card()
        panel.pack_start(label('已结束周期的估值', 'card-title'), False, False, 0)
        self.history, scroll = table(['额度窗口', '周期结束', '当时预计总价值', '样本百分点'])
        panel.pack_start(scroll, True, True, 0)
        box.pack_start(panel, True, True, 0)

    def request(self, action=None):
        if self.busy or self.closed:
            return False
        self.busy = True
        self.spinner.start()
        self.refresh_button.set_sensitive(False)
        self.start_button.set_sensitive(False)
        self.stop_button.set_sensitive(False)
        self.banner.set_text('正在请求真实额度…' if action in ('--refresh', '--measure-start') else '正在更新本地用量…')

        def work():
            try:
                node = shutil.which('node') or '/usr/bin/node'
                args = [node, str(ROOT / 'bin/cli.js'), 'value', '--json']
                if action:
                    args.append(action)
                result = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', timeout=45)
                if not result.stdout.strip():
                    raise RuntimeError(result.stderr.strip() or '统计进程未返回结果')
                data = json.loads(result.stdout)
                GLib.idle_add(self.receive, data, action)
            except Exception as error:
                GLib.idle_add(self.failed, str(error))
        threading.Thread(target=work, daemon=True).start()
        return False

    def receive(self, data, action):
        if self.closed:
            return False
        self.busy = False
        self.spinner.stop()
        self.last_data = data
        self.refresh_button.set_sensitive(True)
        self.export_button.set_sensitive(True)
        healthy = data.get('refresh') in ('live', 'fresh')
        context = self.banner.get_style_context()
        context.remove_class('warning')
        if not healthy:
            context.add_class('warning')
        status = {'live': '已取得真实额度', 'fresh': '使用近期额度快照', 'offline': '网络不可用，显示上次读数',
                  'backoff': '接口退避中，稍后自动重试', 'no_credentials': '未找到当前用户的 Claude 登录',
                  'expired': '登录已过期，请在 Claude Desktop 中重新登录', 'desktop_keyring_locked': '请解锁系统登录钥匙串',
                  'rate_limited': '额度接口限流，稍后自动重试'}.get(data.get('refresh'), '额度暂不可用，保留本地统计')
        self.banner.set_text(f"{data.get('plan', 'Claude')}  ·  {status}  ·  快照 {clock(data.get('snapshotFetchedAt'), True)}")
        if data.get('persistence') is False:
            context.add_class('warning')
            self.banner.set_text('统计可读，但记录保存失败。请检查配置目录的写入权限。')
        rows = {row['key']: row for row in data['windows']}
        self.five.update(rows['five_hour'])
        self.week.update(rows['seven_day'])
        self.models.clear()
        for row in data['windows']:
            for model in row['models']:
                parts = model['parts']
                self.models.append([('5h / ' if row['key'] == 'five_hour' else '每周 / ') + model['model'],
                                    number(parts.get('input')), number(parts.get('cacheWrite')),
                                    number(parts.get('cacheRead')), number(parts.get('output')),
                                    money(model['cost']) + (' *' if model['estimated'] else '')])
        current = data.get('measurement')
        active = bool(current and current['phase'] in ACTIVE)
        self.start_button.set_sensitive(not active and bool(data.get('accountKnown')) and data.get('persistence') is not False)
        self.stop_button.set_sensitive(active)
        if not active:
            self.start_button.set_label('从 0% 开始测量' if rows['five_hour'].get('percentUsed') == 0 else '等待下次清零并测量')
        else:
            self.start_button.set_label('已等待清零' if current['phase'] == 'armed' else '已开始记录')
        self.measure_status.set_text(PHASES.get(current['phase'], '等待测量') if current else '尚未开始测量')
        if current:
            spent = current['spent']
            self.measured_cost.set_text('待补价格' if spent['unknownModels'] else money(spent['usd']))
            self.measured_tokens.set_text(number(spent['tokens']))
            percent = current.get('lastPercent')
            self.measured_percent.set_text(f'{percent:g}%' if isinstance(percent, (int, float)) else '—')
            self.measure_times.set_text('0% 起点 · ' + clock(current.get('zeroAt'), True) + '\n周期重置 · ' + clock(current.get('resetsAt'), True) + '\n记录截止 · ' + clock(current.get('endedAt'), True))
            self.measure_detail.set_text(REASONS.get(current.get('endReason'), '本轮只记录 0% 起点之后的本机调用，达到限制后自动封存。'))
        else:
            self.measured_cost.set_text('—')
            self.measured_tokens.set_text('—')
            self.measured_percent.set_text('—')
        self.history.clear()
        for row in data.get('history', []):
            self.history.append(['5 小时' if row['key'] == 'five_hour' else '每周', clock(row['resetsAt'], True), money(row['totalUSD']), str(row['points'])])
        self.measure_history.clear()
        for row in data.get('measurements', []):
            self.measure_history.append([clock(row.get('zeroAt') or row['armedAt'], True),
                                         REASONS.get(row.get('endReason'), PHASES.get(row['phase'], row['phase'])),
                                         number(row['spent']['tokens']), '待补价格' if row['spent']['unknownModels'] else money(row['spent']['usd'])])
        if action in ('--measure-start', '--measure-stop') or (self.first_load and active):
            self.notebook.set_current_page(1)
        self.first_load = False
        return False

    def failed(self, message):
        if not self.closed:
            self.busy = False
            self.spinner.stop()
            self.refresh_button.set_sensitive(True)
            active = bool(self.last_data and self.last_data.get('measurement') and self.last_data['measurement']['phase'] in ACTIVE)
            self.start_button.set_sensitive(not active)
            self.stop_button.set_sensitive(active)
            self.banner.get_style_context().add_class('warning')
            self.banner.set_text('更新失败：' + message[:240] + '。可点击“立即刷新”重试。')
        return False

    def export(self, _):
        if not self.last_data:
            return
        dialog = Gtk.FileChooserDialog(title='导出额度与测量记录', transient_for=self, action=Gtk.FileChooserAction.SAVE)
        dialog.add_buttons('取消', Gtk.ResponseType.CANCEL, '保存', Gtk.ResponseType.OK)
        dialog.set_do_overwrite_confirmation(True)
        dialog.set_current_name('claude-quota-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.json')
        if dialog.run() == Gtk.ResponseType.OK:
            try:
                pathlib.Path(dialog.get_filename()).write_text(json.dumps(self.last_data, ensure_ascii=False, indent=2), encoding='utf-8')
                self.footer.set_text('记录已导出到：' + dialog.get_filename())
            except OSError as error:
                self.footer.set_text('导出失败：' + str(error))
        dialog.destroy()

    def tick(self):
        self.request()
        return True

    def keypress(self, _, event):
        if event.keyval == Gdk.KEY_F5:
            self.request('--refresh')
            return True
        return False

    def closing(self, *_):
        self.closed = True
        return False


class Application(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='io.github.GodRaymond233.ClaudeQuotaValue', flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.window = None

    def do_activate(self):
        if not self.window or self.window.closed:
            provider = Gtk.CssProvider()
            provider.load_from_data(CSS)
            Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
            self.window = Window(self)
            self.window.show_all()
        self.window.present()


if __name__ == '__main__':
    raise SystemExit(Application().run(None))

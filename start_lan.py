"""Interactive LAN launcher for a trusted company network."""
import getpass
from pathlib import Path
import socket
import sys
import webbrowser

from app import create_server
from template_manager.auth import Auth


def main():
    data = Path(__file__).resolve().parent / '.data' / 'library'
    auth = Auth(data.parent / 'accounts.sqlite3')
    with auth.db() as db:
        empty = db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0
    print('模板仓 · 公司局域网共享版')
    print('请仅在可信公司局域网使用；本模式使用 HTTP，不适合公网访问。')
    print('数据目录：' + str(data.parent))
    if empty:
        print('\n首次使用：创建管理员账号。')
        username = input('管理员用户名（回车使用 admin）：').strip() or 'admin'
        while True:
            password = getpass.getpass('管理员密码（至少 12 字符，输入不显示）：')
            again = getpass.getpass('再次输入密码：')
            if password != again:
                print('两次密码不同，请重试。')
                continue
            try:
                auth.create(username, password, 'admin')
                break
            except ValueError as e:
                print(e)
    addresses = set()
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = item[4][0]
            if not ip.startswith(('127.', '169.254.')) and ip != '0.0.0.0':
                addresses.add(ip)
    except OSError:
        pass
    print('\n检测到的 IPv4 地址：' + (', '.join(sorted(addresses)) or '未检测到'))
    print('如上面未显示公司网卡地址，请用 ipconfig 查看 IPv4 后输入。')
    print('多个网卡时，只把公司有线或 Wi-Fi 网卡地址提供给同事。')
    extra = input('补充公司网卡 IPv4（通常直接回车）：').strip()
    if extra:
        try:
            socket.inet_pton(socket.AF_INET, extra)
        except OSError:
            raise ValueError('请输入有效 IPv4 地址')
        addresses.add(extra)
    if not addresses:
        raise ValueError('没有可用于共享的 IPv4 地址；请连接公司网络后重试')
    port = 8765
    hosts = {f'{ip}:{port}' for ip in addresses}
    hosts.update({f'127.0.0.1:{port}', f'localhost:{port}'})
    server = create_server(data, port, host='0.0.0.0', allowed_hosts=hosts)
    print('\n启动成功。管理员本机地址：http://127.0.0.1:8765')
    print('同事访问地址（选择公司网卡地址）：')
    for ip in sorted(addresses):
        print(f'  http://{ip}:{port}')
    print('\n请保持此窗口打开，按 Ctrl+C 停止。')
    print('若同事无法访问，请按《公司局域网使用指南》配置防火墙。')
    webbrowser.open(f'http://127.0.0.1:{port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。模板和账号保留在 .data 目录。')
    finally:
        server.server_close()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as e:
        print('启动失败：' + str(e))
        sys.exit(1)

import Foundation
import AppKit
import WebKit

// Xbox 网页串流 - macOS 原生 App 启动器
// 原生窗口 (WKWebView) 内嵌串流界面 + 管理内嵌 python 服务子进程。
// 菜单保留「在浏览器打开」作为手柄兼容性的备用路径。

let resPath = Bundle.main.resourcePath!
let dataDir = NSHomeDirectory() + "/Library/Application Support/XboxWebRemote"
let logPath = NSHomeDirectory() + "/Library/Logs/XboxWebRemote.log"
let serverURL = URL(string: "http://127.0.0.1:8977")!

func ensureLogFile() {
    try? FileManager.default.createDirectory(
        atPath: NSHomeDirectory() + "/Library/Logs", withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: logPath) {
        FileManager.default.createFile(atPath: logPath, contents: nil)
    }
}

func logLine(_ s: String) {
    ensureLogFile()
    let line = "\(Date()) \(s)\n"
    if let fh = FileHandle(forWritingAtPath: logPath) {
        fh.seekToEndOfFile()
        fh.write(line.data(using: .utf8)!)
        try? fh.close()
    }
}

func portOpen(_ port: UInt16) -> Bool {
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }
    let r = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    return r == 0
}

var pythonProc: Process?

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {
    var webView: WKWebView?
    var mainWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let p = pythonProc, p.isRunning {
            p.terminate()
            let deadline = Date().addingTimeInterval(1)
            while p.isRunning && Date() < deadline { usleep(50000) }
            if p.isRunning { p.terminate() }
        }
        logLine("服务已停止 (App 退出)")
    }

    // 再次点击 Dock 图标: 聚焦主窗口
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow?.makeKeyAndOrderFront(nil)
        return true
    }

    // ---------- 主窗口 ----------
    func buildWindow() {
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        win.title = "Xbox 网页串流"
        win.minSize = NSSize(width: 800, height: 500)
        win.center()

        let config = WKWebViewConfiguration()
        // 串流音频需要自动播放
        config.mediaTypesRequiringUserActionForPlayback = []

        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: config)
        wv.autoresizingMask = [NSView.AutoresizingMask.width, NSView.AutoresizingMask.height]
        wv.uiDelegate = self
        win.contentView = wv
        webView = wv
        mainWindow = win
        win.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)

        // 服务未就绪时先轮询再加载 (等待期间显示提示页)
        if portOpen(8977) {
            wv.load(URLRequest(url: serverURL))
        } else {
            wv.loadHTMLString(waitingHTML(), baseURL: nil)
            DispatchQueue.global().async {
                for _ in 0..<40 {
                    if portOpen(8977) {
                        DispatchQueue.main.async {
                            self.webView?.load(URLRequest(url: serverURL))
                        }
                        return
                    }
                    usleep(500000)
                }
                DispatchQueue.main.async {
                    self.webView?.loadHTMLString(timeoutHTML(), baseURL: nil)
                }
            }
        }
    }

    // ---------- 页面 window.open (直播模式独立窗口) ----------
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let width = windowFeatures.width?.intValue ?? 1280
        let height = windowFeatures.height?.intValue ?? 720
        let win = NSWindow(contentRect: NSRect(x: 60, y: 60, width: width, height: height),
                           styleMask: [.titled, .closable, .resizable],
                           backing: .buffered, defer: false)
        win.title = "Xbox 直播窗口"
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height),
                           configuration: configuration)
        wv.autoresizingMask = [NSView.AutoresizingMask.width, NSView.AutoresizingMask.height]
        win.contentView = wv
        win.makeKeyAndOrderFront(nil)
        // 返回后 WebKit 会自动 load navigationAction.request
        return wv
    }

    // ---------- 菜单动作 ----------
    @objc func openInBrowser() {
        NSWorkspace.shared.open(serverURL)
    }
}

func waitingHTML() -> String {
    return "<body style='background:#0e1116;color:#8b97a8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif'><div>正在启动本地服务…</div></body>"
}

func timeoutHTML() -> String {
    return "<body style='background:#0e1116;color:#e05a5a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif'><div>服务启动超时，日志见 ~/Library/Logs/XboxWebRemote.log</div></body>"
}

// 基本菜单栏
let mainMenu = NSMenu()
let appMenuItem = NSMenuItem()
mainMenu.addItem(appMenuItem)
let appMenu = NSMenu()
let browserItem = NSMenuItem(title: "在浏览器打开", action: #selector(AppDelegate.openInBrowser), keyEquivalent: "b")
appMenu.addItem(browserItem)
appMenu.addItem(.separator())
appMenu.addItem(NSMenuItem(title: "退出 Xbox网页串流", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
appMenuItem.submenu = appMenu
app.mainMenu = mainMenu

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)

// ---------- 已有服务在跑? 直接复用 (不接管别人的进程) ----------
let serviceRunning = portOpen(8977)

// ---------- 数据目录 / 日志 ----------
try? FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
ensureLogFile()

// ---------- 注册内嵌的登录回调助手 (幂等) ----------
let helperPath = resPath + "/XboxLoginHelper.app"
let lsreg = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if FileManager.default.fileExists(atPath: helperPath) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: lsreg)
    p.arguments = ["-f", helperPath]
    try? p.run()
    p.waitUntilExit()
}

// ---------- 拉起 python 服务 ----------
if !serviceRunning {
    let py = Process()
    py.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    py.arguments = [resPath + "/server.py"]
    py.currentDirectoryURL = URL(fileURLWithPath: resPath)
    py.environment = ["XWR_DATA_DIR": dataDir,
                      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                      "HOME": NSHomeDirectory()]
    if let fh = FileHandle(forWritingAtPath: logPath) {
        fh.seekToEndOfFile()
        py.standardOutput = fh
        py.standardError = fh
    }
    pythonProc = py
    do {
        try py.run()
        logLine("服务已启动 (python3 server.py, pid=\(py.processIdentifier))")
    } catch {
        logLine("服务启动失败: \(error)")
    }
} else {
    logLine("8977 已有服务运行, 直接复用")
}

app.run()

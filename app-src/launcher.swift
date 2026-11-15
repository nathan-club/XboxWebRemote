import Foundation
import AppKit

// Xbox 网页串流 - macOS App 启动器
// 职责: 拉起内嵌的 python 服务 (子进程), 等端口就绪后打开浏览器,
//       注册登录回调助手, 退出 App 时干净地停掉服务。

let resPath = Bundle.main.resourcePath!
let dataDir = NSHomeDirectory() + "/Library/Application Support/XboxWebRemote"
let logPath = NSHomeDirectory() + "/Library/Logs/XboxWebRemote.log"

func ensureLogFile() {
    if !FileManager.default.fileExists(atPath: logPath) {
        FileManager.default.createFile(atPath: logPath, contents: nil)
    }
}
let browserURL = URL(string: "http://127.0.0.1:8977")!

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

func openBrowser() {
    NSWorkspace.shared.open(browserURL)
}

var pythonProc: Process?

final class Delegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        if let p = pythonProc, p.isRunning {
            p.terminate()
            // 给 1 秒宽限, 仍不退则强杀
            let deadline = Date().addingTimeInterval(1)
            while p.isRunning && Date() < deadline { usleep(50000) }
            if p.isRunning { p.terminate() }
        }
        logLine("服务已停止 (App 退出)")
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular) // Dock 显示, 有点可退

// ---------- 已有服务在跑? 只开浏览器, 不接管 ----------
if portOpen(8977) {
    logLine("8977 已有服务在运行, 直接打开浏览器")
    openBrowser()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
    app.run()
    exit(0)
}

// ---------- 数据目录 / 日志 ----------
try? FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
try? FileManager.default.createDirectory(atPath: NSHomeDirectory() + "/Library/Logs", withIntermediateDirectories: true)

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
let py = Process()
py.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
py.arguments = [resPath + "/server.py"]
py.currentDirectoryURL = URL(fileURLWithPath: resPath)
py.environment = ["XWR_DATA_DIR": dataDir,
                  "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                  "HOME": NSHomeDirectory()]
ensureLogFile()
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
    let alert = NSAlert()
    alert.messageText = "服务启动失败"
    alert.informativeText = "无法运行 /usr/bin/python3，请确认已安装 macOS 命令行开发者工具。日志: \(logPath)"
    alert.runModal()
    exit(1)
}

// ---------- 等端口就绪 (最多 20 秒) 打开浏览器 ----------
DispatchQueue.global().async {
    var opened = false
    for _ in 0..<40 {
        if portOpen(8977) {
            DispatchQueue.main.async { openBrowser() }
            opened = true
            break
        }
        usleep(500000)
    }
    if !opened { logLine("等待 8977 就绪超时") }
}

app.run()

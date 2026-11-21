import AppKit

@MainActor
final class CaptureFixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let result = NSTextField(labelWithString: "Waiting for input")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 180),
            styleMask: [.titled, .closable], backing: .buffered, defer: false
        )
        window.title = "Roppo Desktop Test"
        let button = NSButton(title: "Set native result", target: self, action: #selector(updateResult))
        button.frame = NSRect(x: 35, y: 96, width: 270, height: 32)
        result.frame = NSRect(x: 35, y: 55, width: 270, height: 24)
        window.contentView?.addSubview(button)
        window.contentView?.addSubview(result)
        self.window = window
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func updateResult() {
        result.stringValue = "Native result 42"
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

@main
struct CaptureFixtureMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = CaptureFixture()
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

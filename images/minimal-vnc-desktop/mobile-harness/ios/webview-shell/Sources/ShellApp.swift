import UIKit
import WebKit

/// One full-window WKWebView, one URL, no browser chrome. The harness treats
/// the device framebuffer as the source of truth, so this app adds no UI of its
/// own and never injects script into the page under test.
///
/// Launch:
///   xcrun simctl openurl <udid> 'popcorn-shell://open?url=<percent-encoded-url>'
///   xcrun simctl launch --terminate-running-process <udid> \
///     org.reclaimprotocol.popcorn.webviewshell -url '<url>'
///
/// Options travel with either form: userAgent, fullscreen, javaScript,
/// clearData, inspect.
final class AppDelegate: UIResponder, UIApplicationDelegate {

  private static let logTag = "PopcornShell"

  var window: UIWindow?
  private var webView: WKWebView!
  private var edgeConstraints: [NSLayoutConstraint] = []

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.suppressesIncrementalRendering = false

    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    webView.backgroundColor = .white
    webView.isOpaque = true
    // Keep the page's own layout: no automatic content inset, so the framebuffer
    // shows what the page asked for.
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.translatesAutoresizingMaskIntoConstraints = false

    let root = UIViewController()
    root.view.backgroundColor = .white
    root.view.addSubview(webView)

    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = root
    window.backgroundColor = .white
    window.makeKeyAndVisible()
    self.window = window

    let options = ShellOptions(arguments: CommandLine.arguments)
    apply(options)
    load(options)
    return true
  }

  func application(
    _ application: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    guard let shellOptions = ShellOptions(launchURL: url) else {
      NSLog("%@ ignored launch url with no target", AppDelegate.logTag)
      return false
    }
    apply(shellOptions)
    load(shellOptions)
    return true
  }

  private func apply(_ options: ShellOptions) {
    webView.configuration.defaultWebpagePreferences.allowsContentJavaScript = options.javaScript
    if let userAgent = options.userAgent, !userAgent.isEmpty {
      webView.customUserAgent = userAgent
    }
    if #available(iOS 16.4, *) {
      webView.isInspectable = options.inspect
    }
    if options.clearData {
      clearBrowsingData()
    }
    guard let container = webView.superview else { return }
    NSLayoutConstraint.deactivate(edgeConstraints)
    // Safari draws its own chrome, so the shell's default is the safe area and
    // `fullscreen` opts into edge-to-edge instead.
    let anchors = options.fullscreen ? container : container.safeAreaLayoutGuide as Any
    edgeConstraints = AppDelegate.constraints(pinning: webView, to: anchors)
    NSLayoutConstraint.activate(edgeConstraints)
    NSLog("%@ configured javaScript=%@ fullscreen=%@ userAgent=%@",
          AppDelegate.logTag,
          String(options.javaScript),
          String(options.fullscreen),
          options.userAgent ?? "<default>")
  }

  private static func constraints(pinning view: UIView, to anchors: Any) -> [NSLayoutConstraint] {
    if let guide = anchors as? UILayoutGuide {
      return [
        view.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
        view.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
        view.topAnchor.constraint(equalTo: guide.topAnchor),
        view.bottomAnchor.constraint(equalTo: guide.bottomAnchor),
      ]
    }
    guard let container = anchors as? UIView else { return [] }
    return [
      view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      view.topAnchor.constraint(equalTo: container.topAnchor),
      view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ]
  }

  private func clearBrowsingData() {
    let store = webView.configuration.websiteDataStore
    store.removeData(
      ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
      modifiedSince: Date(timeIntervalSince1970: 0)
    ) {
      NSLog("%@ cleared cookies, web storage, and cache", AppDelegate.logTag)
    }
  }

  private func load(_ options: ShellOptions) {
    guard let target = options.url else {
      NSLog("%@ no url supplied; staying blank", AppDelegate.logTag)
      webView.loadHTMLString("", baseURL: nil)
      return
    }
    // Query strings can carry a LiveView viewer token, so the log gets the
    // origin and path only.
    NSLog("%@ loading %@", AppDelegate.logTag, ShellOptions.describe(target))
    webView.load(URLRequest(url: target))
  }
}

extension AppDelegate: WKNavigationDelegate {
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let scheme = navigationAction.request.url?.scheme?.lowercased()
    let web = scheme == "http" || scheme == "https" || scheme == "about"
    // Keep every web navigation in this WebView, and refuse to hand non-web
    // schemes to another app mid-test.
    if !web {
      NSLog("%@ blocked non-web navigation scheme=%@", AppDelegate.logTag, scheme ?? "<none>")
    }
    decisionHandler(web ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    NSLog("%@ page finished %@", AppDelegate.logTag,
          webView.url.map(ShellOptions.describe) ?? "<no url>")
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    NSLog("%@ navigation failed %@", AppDelegate.logTag, error.localizedDescription)
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    NSLog("%@ provisional navigation failed %@", AppDelegate.logTag, error.localizedDescription)
  }
}

extension AppDelegate: WKUIDelegate {
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    // One surface only: a second window would be invisible to the framebuffer.
    if let request = navigationAction.request.url.map({ URLRequest(url: $0) }) {
      webView.load(request)
    }
    return nil
  }

  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    // Camera and microphone gates in embedded verification flows would
    // otherwise stall with no visible reason.
    NSLog("%@ granting media capture type=%ld", AppDelegate.logTag, type.rawValue)
    decisionHandler(.grant)
  }
}

/// Options arrive either as launch arguments or in the query of a
/// `popcorn-shell://` URL, so both forms parse into the same values.
struct ShellOptions {
  var url: URL?
  var userAgent: String?
  var fullscreen = false
  var javaScript = true
  var clearData = false
  var inspect = true

  init(values: [String: String]) {
    if let raw = values["url"]?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
      url = URL(string: raw)
    }
    userAgent = values["userAgent"]
    fullscreen = ShellOptions.flag(values["fullscreen"], fullscreen)
    javaScript = ShellOptions.flag(values["javaScript"], javaScript)
    clearData = ShellOptions.flag(values["clearData"], clearData)
    inspect = ShellOptions.flag(values["inspect"], inspect)
  }

  init(arguments: [String]) {
    var values: [String: String] = [:]
    var index = 1
    while index < arguments.count {
      let argument = arguments[index]
      guard argument.hasPrefix("-"), index + 1 < arguments.count else {
        index += 1
        continue
      }
      values[String(argument.dropFirst())] = arguments[index + 1]
      index += 2
    }
    self.init(values: values)
  }

  init?(launchURL: URL) {
    guard let components = URLComponents(url: launchURL, resolvingAgainstBaseURL: false) else {
      return nil
    }
    var values: [String: String] = [:]
    for item in components.queryItems ?? [] {
      if let value = item.value { values[item.name] = value }
    }
    if values["url"] == nil { return nil }
    self.init(values: values)
  }

  private static func flag(_ raw: String?, _ fallback: Bool) -> Bool {
    guard let raw = raw?.lowercased() else { return fallback }
    if ["1", "true", "yes"].contains(raw) { return true }
    if ["0", "false", "no"].contains(raw) { return false }
    return fallback
  }

  static func describe(_ url: URL) -> String {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return "<unparsable-url>"
    }
    components.query = nil
    components.fragment = nil
    return components.string ?? "<unparsable-url>"
  }
}

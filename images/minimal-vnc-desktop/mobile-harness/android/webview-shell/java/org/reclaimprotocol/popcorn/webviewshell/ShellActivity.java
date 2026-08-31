package org.reclaimprotocol.popcorn.webviewshell;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * One full-window WebView, one URL, no browser chrome. The harness treats the
 * device framebuffer as the source of truth, so this activity adds no UI of its
 * own and never injects script into the page under test.
 *
 * Launch:
 *   am start -W -n org.reclaimprotocol.popcorn.webviewshell/.ShellActivity --es url '<url>'
 *   am start -W -a android.intent.action.VIEW -p org.reclaimprotocol.popcorn.webviewshell -d '<url>'
 *
 * Optional extras: userAgent (string), fullscreen, wideViewPort, javaScript,
 * thirdPartyCookies, clearData, debug (booleans).
 */
public final class ShellActivity extends Activity {

  private static final String TAG = "PopcornShell";

  private static final String EXTRA_URL = "url";
  private static final String EXTRA_USER_AGENT = "userAgent";
  private static final String EXTRA_FULLSCREEN = "fullscreen";
  private static final String EXTRA_WIDE_VIEWPORT = "wideViewPort";
  private static final String EXTRA_JAVASCRIPT = "javaScript";
  private static final String EXTRA_THIRD_PARTY_COOKIES = "thirdPartyCookies";
  private static final String EXTRA_CLEAR_DATA = "clearData";
  private static final String EXTRA_DEBUG = "debug";
  private static final String EXTRA_SOFT_INPUT = "softInput";

  private WebView webView;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    Intent intent = getIntent();

    webView = new WebView(this);
    webView.setBackgroundColor(Color.WHITE);
    webView.setWebViewClient(new ShellWebViewClient());
    webView.setWebChromeClient(new ShellWebChromeClient());
    configure(webView, intent);

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.WHITE);
    root.addView(webView, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(root);

    applySoftInputMode(intent);

    if (flag(intent, EXTRA_FULLSCREEN, false)) {
      getWindow().getDecorView().setSystemUiVisibility(
          View.SYSTEM_UI_FLAG_LAYOUT_STABLE
              | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
              | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_FULLSCREEN
              | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    if (flag(intent, EXTRA_CLEAR_DATA, false)) {
      clearBrowsingData();
    }
    load(intent);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (flag(intent, EXTRA_CLEAR_DATA, false)) {
      clearBrowsingData();
    }
    load(intent);
  }

  @Override
  public void onBackPressed() {
    if (webView != null && webView.canGoBack()) {
      webView.goBack();
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    if (webView != null) {
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }

  /**
   * How the window reacts to the soft keyboard, which decides what the page
   * sees. `resize` shrinks the window, and WebView turns that into a smaller
   * layout viewport, so the page reflows: 100vh boxes shrink and bottom-pinned
   * elements jump. A browser instead keeps the layout viewport and shrinks only
   * the visual viewport, which is what `nothing` and `pan` leave room for.
   */
  private void applySoftInputMode(Intent intent) {
    String mode = intent == null ? null : intent.getStringExtra(EXTRA_SOFT_INPUT);
    if (mode == null || mode.trim().isEmpty()) return;
    int flags;
    switch (mode.trim().toLowerCase()) {
      case "resize":
        flags = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        break;
      case "pan":
        flags = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN;
        break;
      case "nothing":
        flags = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING;
        break;
      default:
        Log.w(TAG, "unknown softInput mode " + mode);
        return;
    }
    getWindow().setSoftInputMode(flags);
    Log.i(TAG, "soft input mode " + mode);
  }

  private void configure(WebView view, Intent intent) {
    boolean wideViewPort = flag(intent, EXTRA_WIDE_VIEWPORT, true);
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(flag(intent, EXTRA_JAVASCRIPT, true));
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    // Browser-equivalent viewport handling: without these a WebView ignores the
    // page's viewport meta tag and every layout comparison drifts.
    settings.setUseWideViewPort(wideViewPort);
    settings.setLoadWithOverviewMode(wideViewPort);
    settings.setBuiltInZoomControls(true);
    settings.setDisplayZoomControls(false);
    settings.setSupportZoom(true);
    // Ignore the device font-scale setting so screenshots stay comparable.
    settings.setTextZoom(100);
    settings.setSupportMultipleWindows(false);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);

    String userAgent = intent == null ? null : intent.getStringExtra(EXTRA_USER_AGENT);
    if (userAgent != null && !userAgent.trim().isEmpty()) {
      settings.setUserAgentString(userAgent);
    }

    CookieManager cookies = CookieManager.getInstance();
    cookies.setAcceptCookie(true);
    cookies.setAcceptThirdPartyCookies(view, flag(intent, EXTRA_THIRD_PARTY_COOKIES, true));

    WebView.setWebContentsDebuggingEnabled(flag(intent, EXTRA_DEBUG, true));
    Log.i(TAG, "shell configured javaScript=" + settings.getJavaScriptEnabled()
        + " wideViewPort=" + wideViewPort
        + " userAgent=" + settings.getUserAgentString());
  }

  private void clearBrowsingData() {
    CookieManager.getInstance().removeAllCookies(null);
    CookieManager.getInstance().flush();
    WebStorage.getInstance().deleteAllData();
    if (webView != null) {
      webView.clearHistory();
      webView.clearCache(true);
    }
    Log.i(TAG, "cleared cookies, web storage, and cache");
  }

  private void load(Intent intent) {
    String url = resolveUrl(intent);
    // Query strings can carry a LiveView viewer token, so logcat gets the
    // origin and path only.
    Log.i(TAG, "loading " + describe(url));
    webView.loadUrl(url);
  }

  private static String resolveUrl(Intent intent) {
    if (intent != null) {
      String extra = intent.getStringExtra(EXTRA_URL);
      if (extra != null && !extra.trim().isEmpty()) return extra.trim();
      String data = intent.getDataString();
      if (data != null && !data.trim().isEmpty()) return data.trim();
    }
    return "about:blank";
  }

  private static String describe(String url) {
    try {
      Uri uri = Uri.parse(url);
      String path = uri.getPath();
      return uri.getScheme() + "://" + uri.getAuthority() + (path == null ? "" : path);
    } catch (RuntimeException error) {
      return "<unparsable-url>";
    }
  }

  private static boolean flag(Intent intent, String key, boolean fallback) {
    return intent == null ? fallback : intent.getBooleanExtra(key, fallback);
  }

  private static final class ShellWebViewClient extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      String scheme = request.getUrl().getScheme();
      boolean web = "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
      // Keep every web navigation in this WebView, and refuse to hand
      // non-web schemes to another app mid-test.
      if (!web) Log.w(TAG, "blocked non-web navigation scheme=" + scheme);
      return !web;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
      Log.i(TAG, "page finished " + describe(url));
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
      Log.w(TAG, "resource error " + describe(request.getUrl().toString())
          + " code=" + error.getErrorCode());
    }
  }

  private static final class ShellWebChromeClient extends WebChromeClient {
    @Override
    public void onPermissionRequest(PermissionRequest request) {
      // Camera and microphone gates in embedded verification flows would
      // otherwise stall with no visible reason.
      Log.i(TAG, "granting web permissions " + String.join(",", request.getResources()));
      request.grant(request.getResources());
    }

    @Override
    public boolean onConsoleMessage(ConsoleMessage message) {
      Log.i(TAG, "console " + message.messageLevel() + " " + message.message());
      return true;
    }

    @Override
    public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
        FileChooserParams params) {
      // No native picker is wired up; cancel explicitly so the page gets an
      // answer instead of hanging.
      Log.w(TAG, "file chooser requested and cancelled");
      callback.onReceiveValue(null);
      return true;
    }
  }
}

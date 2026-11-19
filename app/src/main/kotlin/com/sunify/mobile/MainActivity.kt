package com.sunify.mobile

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val prefs by lazy { getSharedPreferences("sunify_secure_auth", MODE_PRIVATE) }
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        cb.onReceiveValue(uris)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.parseColor("#0A0910")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(this, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }

        val app = application as SunifyApplication
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0A0910"))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = true
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                useWideViewPort = true
                loadWithOverviewMode = true
                cacheMode = WebSettings.LOAD_NO_CACHE
            }
            clearCache(true)
            addJavascriptInterface(SunifyAndroidBridge(), "SunifyAndroidBridge")
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView?,
                    callback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?
                ): Boolean {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = callback
                    val pickIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "image/*"
                    }
                    return runCatching {
                        fileChooserLauncher.launch(Intent.createChooser(pickIntent, "Görsel Seç"))
                        true
                    }.getOrElse {
                        filePathCallback = null
                        false
                    }
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? {
                    return assetLoader.shouldInterceptRequest(request.url)
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (url.startsWith("https://appassets.androidplatform.net/")) return false
                    if (url.startsWith("https://") || url.startsWith("http://")) {
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                        return true
                    }
                    return false
                }
            }
        }
        setContentView(webView)

        MediaPlaybackService.onMediaAction = { cmd ->
            runOnUiThread {
                val safeCmd = cmd.replace("'", "")
                webView.evaluateJavascript("window.__sunifyOnAndroidMediaAction && window.__sunifyOnAndroidMediaAction('${safeCmd}')", null)
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    """
                    (() => {
                      const sheet = document.getElementById('sheetBackdrop');
                      if (sheet && !sheet.hidden) { document.getElementById('sheetCloseBtn')?.click(); return 'handled'; }
                      const np = document.getElementById('nowPlayingModal');
                      if (np && np.classList.contains('open')) { document.getElementById('npCloseBtn')?.click(); return 'handled'; }
                      const detail = document.getElementById('viewDetail');
                      if (detail && detail.classList.contains('active')) { document.getElementById('detailBackBtn')?.click(); return 'handled'; }
                      const artist = document.getElementById('viewArtist');
                      if (artist && artist.classList.contains('active')) { document.getElementById('artistBackBtn')?.click(); return 'handled'; }
                      const home = document.getElementById('viewHome');
                      if (home && !home.classList.contains('active')) { document.getElementById('mBrandBtn')?.click(); return 'handled'; }
                      return 'exit';
                    })();
                    """.trimIndent()
                ) { result ->
                    if (result?.contains("exit") == true) {
                        moveTaskToBack(true)
                    }
                }
            }
        })

        webView.loadUrl("https://appassets.androidplatform.net/assets/renderer/mobile.html?apiPort=${app.apiPort}")
    }

    inner class SunifyAndroidBridge {
        @JavascriptInterface
        fun getAppVersion(): String = "1.2.1"

        @JavascriptInterface
        fun getSecureAuthValue(key: String): String? = prefs.getString(key, null)

        @JavascriptInterface
        fun setSecureAuthValue(key: String, value: String): Boolean {
            prefs.edit().putString(key, value).apply()
            return true
        }

        @JavascriptInterface
        fun deleteSecureAuthValue(key: String) {
            prefs.edit().remove(key).apply()
        }

        @JavascriptInterface
        fun isWifiConnected(): Boolean {
            return runCatching {
                val cm = getSystemService(CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
                val network = cm.activeNetwork ?: return false
                val caps = cm.getNetworkCapabilities(network) ?: return false
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            }.getOrDefault(false)
        }

        @JavascriptInterface
        fun shareImageDataUrl(dataUrl: String, fileName: String, shareTitle: String): Boolean {
            return runCatching {
                val base64Part = dataUrl.substringAfter(",", "")
                if (base64Part.isBlank()) return false
                val bytes = Base64.decode(base64Part, Base64.DEFAULT)
                if (bytes.isEmpty()) return false

                val dir = File(cacheDir, "shared")
                if (!dir.exists()) dir.mkdirs()
                val safeName = fileName.replace(Regex("[^a-zA-Z0-9._-]"), "_").ifBlank { "sunify-kart.png" }
                val outFile = File(dir, safeName)
                outFile.writeBytes(bytes)

                val contentUri = FileProvider.getUriForFile(this@MainActivity, "${packageName}.fileprovider", outFile)
                val shareIntent = Intent(Intent.ACTION_SEND).apply {
                    type = "image/png"
                    putExtra(Intent.EXTRA_STREAM, contentUri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                runOnUiThread {
                    startActivity(Intent.createChooser(shareIntent, shareTitle.ifBlank { "Sunify ile Paylaş" }))
                }
                true
            }.getOrDefault(false)
        }

        @JavascriptInterface
        fun updatePlaybackNotification(stateJson: String) {
            val obj = runCatching { JSONObject(stateJson) }.getOrNull() ?: return
            val title = obj.optString("title", "Sunify").ifBlank { "Sunify" }
            val artist = obj.optString("artist", "Sunify").ifBlank { "Sunify" }
            val playing = if (obj.has("isPlaying")) obj.optBoolean("isPlaying", false) else obj.optBoolean("playing", false)
            val thumbnail = obj.optString("thumbnail", "")
            val durationMs = obj.optLong("durationMs", 0L).coerceAtLeast(0L)
            val positionMs = obj.optLong("positionMs", 0L).coerceAtLeast(0L)
            val liked = obj.optBoolean("liked", false)
            val coverRgb = obj.optString("coverRgb", "181, 122, 255")

            val intent = Intent(this@MainActivity, MediaPlaybackService::class.java).apply {
                action = MediaPlaybackService.ACTION_UPDATE
                putExtra(MediaPlaybackService.EXTRA_TITLE, title)
                putExtra(MediaPlaybackService.EXTRA_ARTIST, artist)
                putExtra(MediaPlaybackService.EXTRA_PLAYING, playing)
                putExtra(MediaPlaybackService.EXTRA_THUMBNAIL, thumbnail)
                putExtra(MediaPlaybackService.EXTRA_DURATION_MS, durationMs)
                putExtra(MediaPlaybackService.EXTRA_POSITION_MS, positionMs)
                putExtra(MediaPlaybackService.EXTRA_LIKED, liked)
                putExtra(MediaPlaybackService.EXTRA_COVER_RGB, coverRgb)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(this@MainActivity, intent)
            } else {
                startService(intent)
            }
        }
    }
}

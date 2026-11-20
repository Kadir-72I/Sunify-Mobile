package com.sunify.mobile

import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.RingtoneManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
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
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val prefs by lazy { getSharedPreferences("sunify_secure_auth", MODE_PRIVATE) }
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingDeepLink: String? = null
    private var pageLoaded = false

    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val cb = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        cb.onReceiveValue(uris)
    }

    private fun audioReadPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            android.Manifest.permission.READ_MEDIA_AUDIO
        } else {
            android.Manifest.permission.READ_EXTERNAL_STORAGE
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

        captureDeepLinkFromIntent(intent)

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0A0910"))
            setLayerType(WebView.LAYER_TYPE_HARDWARE, null)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = true
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                useWideViewPort = true
                loadWithOverviewMode = true
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            addJavascriptInterface(SunifyAndroidBridge(app), "SunifyAndroidBridge")
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

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    pageLoaded = true
                    flushPendingDeepLink()
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (url.startsWith("https://appassets.androidplatform.net/")) return false
                    if (url.startsWith("sunify://")) {
                        dispatchDeepLink(url)
                        return true
                    }
                    if (url.startsWith("https://") || url.startsWith("http://")) {
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                        return true
                    }
                    return false
                }
            }
        }
        setContentView(webView)

        app.nativePlayer.onEvent = { type, posSec, durSec, paused ->
            runOnUiThread {
                val safeType = type.replace("'", "")
                webView.evaluateJavascript(
                    "window.__sunifyNativeAudioEvent && window.__sunifyNativeAudioEvent('$safeType',$posSec,$durSec,$paused)",
                    null
                )
            }
        }

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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        captureDeepLinkFromIntent(intent)
        flushPendingDeepLink()
    }

    private fun captureDeepLinkFromIntent(intent: Intent?) {
        val data = intent?.dataString ?: return
        if (data.startsWith("sunify://")) {
            pendingDeepLink = data
        }
    }

    private fun flushPendingDeepLink() {
        val link = pendingDeepLink ?: return
        if (!pageLoaded) return
        pendingDeepLink = null
        dispatchDeepLink(link)
    }

    private fun dispatchDeepLink(url: String) {
        val quoted = JSONObject.quote(url)
        runOnUiThread {
            webView.evaluateJavascript("window.__sunifyOnDeepLink && window.__sunifyOnDeepLink($quoted)", null)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 102) {
            val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            runOnUiThread {
                webView.evaluateJavascript("window.__sunifyOnAudioPermResult && window.__sunifyOnAudioPermResult($granted)", null)
            }
        }
    }

    inner class SunifyAndroidBridge(private val app: SunifyApplication) {
        @JavascriptInterface
        fun getAppVersion(): String = "1.2.1"

        @JavascriptInterface
        fun hasNativeAudio(): Boolean = true

        @JavascriptInterface
        fun nativeAudioSetSource(url: String, autoPlay: Boolean, startSec: Double) {
            app.nativePlayer.setSourceAndPlay(url, autoPlay, startSec)
        }

        @JavascriptInterface
        fun nativeAudioPlay() {
            app.nativePlayer.play()
        }

        @JavascriptInterface
        fun nativeAudioPause() {
            app.nativePlayer.pause()
        }

        @JavascriptInterface
        fun nativeAudioSeek(sec: Double) {
            app.nativePlayer.seekToSec(sec)
        }

        @JavascriptInterface
        fun nativeAudioSetVolume(vol: Double) {
            app.nativePlayer.setVolume(vol.toFloat())
        }

        @JavascriptInterface
        fun nativeAudioSetSpeedPitch(rate: Double, preservesPitch: Boolean) {
            app.nativePlayer.setSpeedPitch(rate.toFloat(), preservesPitch)
        }

        @JavascriptInterface
        fun nativeAudioSetEqBands(bandsJson: String) {
            val arr = runCatching { JSONArray(bandsJson) }.getOrNull() ?: return
            val floats = FloatArray(10) { idx -> arr.optDouble(idx, 0.0).toFloat() }
            app.nativePlayer.setEqBands(floats)
        }

        @JavascriptInterface
        fun nativeAudioSetNormalization(enabled: Boolean) {
            app.nativePlayer.setNormalization(enabled)
        }

        @JavascriptInterface
        fun nativeAudioSetReverb(amount: Double) {
            app.nativePlayer.setReverb(amount.toFloat())
        }

        @JavascriptInterface
        fun hasDeviceMusicPermission(): Boolean {
            return ContextCompat.checkSelfPermission(this@MainActivity, audioReadPermission()) == PackageManager.PERMISSION_GRANTED
        }

        @JavascriptInterface
        fun requestDeviceMusicPermission() {
            runOnUiThread {
                ActivityCompat.requestPermissions(this@MainActivity, arrayOf(audioReadPermission()), 102)
            }
        }

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
        fun shareFilePath(filePath: String, mimeType: String, shareTitle: String): Boolean {
            return runCatching {
                val file = File(filePath)
                if (!file.exists()) return false
                val contentUri = FileProvider.getUriForFile(this@MainActivity, "${packageName}.fileprovider", file)
                val shareIntent = Intent(Intent.ACTION_SEND).apply {
                    type = mimeType.ifBlank { "*/*" }
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
        fun setAsRingtone(filePath: String, title: String): String {
            return runCatching {
                val srcFile = File(filePath)
                if (!srcFile.exists()) return "error"
                if (!Settings.System.canWrite(this@MainActivity)) {
                    runOnUiThread {
                        val permIntent = Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS).apply {
                            data = Uri.parse("package:$packageName")
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        runCatching { startActivity(permIntent) }
                    }
                    return "need_permission"
                }

                val safeName = "${title.replace(Regex("[\\\\/:*?\"<>|]+"), " ").trim().ifEmpty { "Sunify Zil Sesi" }.take(60)}.mp3"
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                    put(MediaStore.MediaColumns.TITLE, title.ifBlank { "Sunify Zil Sesi" })
                    put(MediaStore.MediaColumns.MIME_TYPE, "audio/mpeg")
                    put(MediaStore.Audio.Media.IS_RINGTONE, true)
                    put(MediaStore.Audio.Media.IS_MUSIC, false)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_RINGTONES}/Sunify")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                }
                val uri = contentResolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values) ?: return "error"
                contentResolver.openOutputStream(uri)?.use { os ->
                    srcFile.inputStream().buffered(65536).use { it.copyTo(os, 65536) }
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    values.clear()
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    contentResolver.update(uri, values, null, null)
                }
                RingtoneManager.setActualDefaultRingtoneUri(this@MainActivity, RingtoneManager.TYPE_RINGTONE, uri)
                "ok"
            }.getOrDefault("error")
        }

        @JavascriptInterface
        fun installUpdateApk(apkUrl: String): Boolean {
            if (!apkUrl.startsWith("https://", true)) return false
            Thread {
                runCatching {
                    val dir = File(cacheDir, "updates").apply { mkdirs() }
                    val apkFile = File(dir, "sunify-mobile-update.apk")
                    val req = Request.Builder()
                        .url(apkUrl)
                        .header("User-Agent", "Sunify-Mobile/1.2.1")
                        .build()
                    OkHttpDownloader.sharedClient.newCall(req).execute().use { res ->
                        if (!res.isSuccessful) return@runCatching
                        res.body?.byteStream()?.use { ins ->
                            apkFile.outputStream().buffered(65536).use { ins.copyTo(it, 65536) }
                        }
                    }
                    if (!apkFile.exists() || apkFile.length() < 1024 * 1024) return@runCatching
                    val contentUri = FileProvider.getUriForFile(this@MainActivity, "${packageName}.fileprovider", apkFile)
                    val installIntent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(contentUri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    runOnUiThread {
                        runCatching { startActivity(installIntent) }
                    }
                }
            }.start()
            return true
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

package com.sunify.mobile

import android.app.Application
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization

class SunifyApplication : Application() {
    lateinit var audioService: YouTubeAudioService
        private set
    lateinit var apiServer: LocalApiServer
        private set
    lateinit var nativePlayer: NativeAudioPlayer
        private set
    var apiPort: Int = 3001
        private set

    override fun onCreate() {
        super.onCreate()
        NewPipe.init(
            OkHttpDownloader.create(),
            Localization("tr", "TR"),
            ContentCountry("TR")
        )
        audioService = YouTubeAudioService(this)
        nativePlayer = NativeAudioPlayer(this)
        apiPort = startAvailableServer()
    }

    private fun startAvailableServer(): Int {
        for (port in 3001..3020) {
            val candidate = LocalApiServer(this, audioService, port)
            try {
                candidate.start(5000, false)
                apiServer = candidate
                return port
            } catch (_: Exception) {
            }
        }
        val fallback = LocalApiServer(this, audioService, 0)
        fallback.start(5000, false)
        apiServer = fallback
        return fallback.listeningPort
    }
}

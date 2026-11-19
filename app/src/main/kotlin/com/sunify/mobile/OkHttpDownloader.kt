package com.sunify.mobile

import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import java.util.concurrent.TimeUnit

class OkHttpDownloader private constructor(
    val client: OkHttpClient
) : Downloader() {

    override fun execute(request: Request): Response {
        val method = request.httpMethod()
        val url = request.url()
        val data = request.dataToSend()

        val headersBuilder = Headers.Builder()
        request.headers().forEach { (key, values) ->
            values.forEach { value -> headersBuilder.add(key, value) }
        }
        if (request.headers()["User-Agent"].isNullOrEmpty()) {
            headersBuilder.add(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            )
        }

        val body = if (data != null && (method == "POST" || method == "PUT" || method == "PATCH")) {
            data.toRequestBody(null)
        } else {
            null
        }

        val okRequest = okhttp3.Request.Builder()
            .url(url)
            .headers(headersBuilder.build())
            .method(method, body)
            .build()

        client.newCall(okRequest).execute().use { res ->
            if (res.code == 429) {
                throw ReCaptchaException("reCaptcha Challenge requested", url)
            }
            val bodyStr = res.body?.string().orEmpty()
            return Response(
                res.code,
                res.message,
                res.headers.toMultimap(),
                bodyStr,
                res.request.url.toString()
            )
        }
    }

    companion object {
        val sharedClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .readTimeout(30, TimeUnit.SECONDS)
                .connectTimeout(20, TimeUnit.SECONDS)
                .followRedirects(true)
                .build()
        }

        fun create(): OkHttpDownloader = OkHttpDownloader(sharedClient)
    }
}

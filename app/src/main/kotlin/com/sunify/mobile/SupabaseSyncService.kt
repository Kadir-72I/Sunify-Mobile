package com.sunify.mobile

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

object SupabaseSyncService {
    private const val SUPABASE_URL = "https://wkphoyochjczmqdmuazo.supabase.co"
    private const val ANON_KEY = "sb_publishable_mEBku9YdyAUCUXGy96Y7UQ_erV1j-9L"
    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    private const val GLOBAL_CHART_EPOCH = 2
    private const val BASELINE_FILE_NAME = "sunify_global_chart_baseline.json"
    private val chartLock = Any()

    private val DEFAULT_EPOCH2_COUNTS = mapOf(
        "massaka|massaka - karanlık(offiziell hd)" to 223L,
        "kobzx2z, mikeeysmind|i just wanna be loved" to 18L,
        "her's|her's - harvey" to 15L,
        "uzi|uzi - cindy" to 12L,
        "massaka|massaka x gekko g - kelebek etkisi" to 11L,
        "alximo|paparazzi (dubstep)" to 8L,
        "korishinc|kaykay 2.0 - era7capone x mikrofon bizness" to 8L,
        "sylendanna|nice 2 know ya instrumental (slowed & reverbed)" to 8L,
        "massaka|massaka - alfa" to 6L,
        "massaka|diablo 63 - diablo prod.by dadasbeats25" to 6L,
        "szxlie|stressed out x haunting x alphabet boy" to 6L,
        "wiv|i love u. - slowed + reverb" to 6L,
        "six lound|[thaisub] harvey - her’s" to 6L,
        "novulent|unknown feelings - novulent" to 5L,
        "massaka|diablo63 - maskem prod.dadasbeats25" to 5L,
        "7clouds rock|dominic fike - babydoll" to 5L,
        "kagan|uzi x manifest - tralala 2.0" to 4L,
        "massaka|diablo 63 - 23 (official 4k)" to 3L,
        "vorfex|murda x ege!" to 3L,
        "ravyn lenae|ravyn lenae - love me not" to 3L,
        "lonown, riserayss|worry - slowed" to 4L,
        "f4st|better luck next time" to 4L,
        "vivi baby, ovg!|my jealousy" to 4L
    )

    data class HttpResult(val code: Int, val body: String)
    class AuthExpiredException(message: String) : IllegalStateException(message)

    private fun call(method: String, path: String, body: String? = null, bearer: String? = null): HttpResult {
        val reqBuilder = Request.Builder()
            .url("$SUPABASE_URL$path")
            .header("apikey", ANON_KEY)
            .header("Authorization", "Bearer ${bearer ?: ANON_KEY}")
            .header("Content-Type", "application/json")

        val reqBody = body?.toRequestBody(JSON_MEDIA)
        when (method.uppercase()) {
            "GET" -> reqBuilder.get()
            "POST" -> reqBuilder.post(reqBody ?: "{}".toRequestBody(JSON_MEDIA))
            "DELETE" -> reqBuilder.delete(reqBody)
        }
        OkHttpDownloader.sharedClient.newCall(reqBuilder.build()).execute().use { res ->
            return HttpResult(res.code, res.body?.string().orEmpty())
        }
    }

    fun login(email: String, password: String): JSONObject {
        val payload = JSONObject().apply {
            put("email", email.trim().lowercase())
            put("password", password)
        }.toString()
        val res = call("POST", "/auth/v1/token?grant_type=password", payload)
        val json = runCatching { JSONObject(res.body) }.getOrDefault(JSONObject())
        if (res.code !in 200..299 || !json.has("access_token")) {
            val msg = json.optString("error_description")
                .ifEmpty { json.optString("msg") }
                .ifEmpty { "E-posta veya şifre hatalı." }
            throw IllegalStateException(msg)
        }
        return JSONObject().apply {
            put("success", true)
            put("mode", "cloud")
            put("user", json.optJSONObject("user") ?: JSONObject())
            put("session", json)
        }
    }

    fun register(username: String, email: String, password: String): JSONObject {
        val payload = JSONObject().apply {
            put("email", email.trim().lowercase())
            put("password", password)
            put("data", JSONObject().put("username", username.trim()))
        }.toString()
        val res = call("POST", "/auth/v1/signup", payload)
        val json = runCatching { JSONObject(res.body) }.getOrDefault(JSONObject())
        if (res.code !in 200..299) {
            val msg = json.optString("msg").ifEmpty { json.optString("error_description") }.ifEmpty { "Kayıt tamamlanamadı." }
            throw IllegalStateException(msg)
        }
        val session = if (json.has("access_token")) json else JSONObject.NULL
        val user = json.optJSONObject("user") ?: json
        return JSONObject().apply {
            put("success", true)
            put("mode", "cloud")
            put("user", user)
            put("session", session)
            put("needsEmailVerification", session === JSONObject.NULL)
        }
    }

    fun validateSession(accessToken: String, refreshToken: String): JSONObject {
        val userRes = call("GET", "/auth/v1/user", bearer = accessToken)
        if (userRes.code in 200..299) {
            val userObj = runCatching { JSONObject(userRes.body) }.getOrDefault(JSONObject())
            return JSONObject().apply {
                put("success", true)
                put("valid", true)
                put("mode", "cloud")
                put("user", userObj)
            }
        }
        if (refreshToken.isNotBlank()) {
            val refPayload = JSONObject().put("refresh_token", refreshToken).toString()
            val refRes = call("POST", "/auth/v1/token?grant_type=refresh_token", refPayload)
            val refJson = runCatching { JSONObject(refRes.body) }.getOrDefault(JSONObject())
            if (refRes.code in 200..299 && refJson.has("access_token")) {
                return JSONObject().apply {
                    put("success", true)
                    put("valid", true)
                    put("mode", "cloud")
                    put("refreshed", true)
                    put("user", refJson.optJSONObject("user") ?: JSONObject())
                    put("session", refJson)
                }
            }
        }
        throw IllegalStateException("Oturumun süresi dolmuş. Lütfen yeniden giriş yap.")
    }

    fun pullAccountData(accessToken: String): JSONObject {
        val userRes = call("GET", "/auth/v1/user", bearer = accessToken)
        if (userRes.code == 401 || userRes.code == 403) {
            throw AuthExpiredException("Oturum süresi doldu.")
        }
        if (userRes.code !in 200..299) {
            throw IllegalStateException("Kullanıcı doğrulanamadı (${userRes.code}).")
        }
        val userJson = runCatching { JSONObject(userRes.body) }.getOrDefault(JSONObject())
        val userId = userJson.optString("id").trim()
        val userFilter = if (userId.isNotEmpty()) "&user_id=eq.${java.net.URLEncoder.encode(userId, "UTF-8")}" else ""

        val plRes = call(
            "GET",
            "/rest/v1/user_playlists?select=id,client_id,name,cover_url,tracks,created_at&order=created_at.desc$userFilter",
            bearer = accessToken
        )
        if (plRes.code == 401 || plRes.code == 403) throw AuthExpiredException("Oturum süresi doldu.")
        if (plRes.code !in 200..299) throw IllegalStateException("Bulut çalma listeleri alınamadı (${plRes.code}).")
        val rawPls = runCatching { JSONArray(plRes.body) }.getOrDefault(JSONArray())
        val playlists = JSONArray()
        for (i in 0 until rawPls.length()) {
            val row = rawPls.optJSONObject(i) ?: continue
            val coverUrl = row.optString("cover_url")
            playlists.put(JSONObject().apply {
                put("id", row.optString("client_id").ifEmpty { row.optString("id") })
                put("name", row.optString("name"))
                put("cover", coverUrl)
                put("cover_url", coverUrl)
                put("tracks", row.optJSONArray("tracks") ?: JSONArray())
                put("created_at", row.optString("created_at"))
            })
        }

        val anRes = call(
            "GET",
            "/rest/v1/user_analytics?select=liked_tracks,listening_stats,updated_at$userFilter&limit=1",
            bearer = accessToken
        )
        if (anRes.code == 401 || anRes.code == 403) throw AuthExpiredException("Oturum süresi doldu.")
        if (anRes.code !in 200..299) throw IllegalStateException("Bulut dinleme verileri alınamadı (${anRes.code}).")
        val anArr = runCatching { JSONArray(anRes.body) }.getOrDefault(JSONArray())
        val anObj = anArr.optJSONObject(0) ?: JSONObject()

        return JSONObject().apply {
            put("playlists", playlists)
            put("analytics", JSONObject().apply {
                put("liked_tracks", anObj.optJSONArray("liked_tracks") ?: JSONArray())
                put("listening_stats", anObj.optJSONObject("listening_stats") ?: JSONObject())
                put("updated_at", anObj.optString("updated_at"))
            })
        }
    }

    fun pushAccountData(accessToken: String, playlists: JSONArray, likedTracks: JSONArray, listeningStats: JSONObject): JSONObject {
        val sanitizedPlaylists = JSONArray()
        val isoRegex = Regex("^\\d{4}-\\d{2}-\\d{2}T.*")
        for (i in 0 until playlists.length()) {
            val rawPl = playlists.optJSONObject(i) ?: continue
            val cleanPl = JSONObject().apply {
                val idVal = rawPl.optString("id").trim()
                if (idVal.isNotEmpty()) put("id", idVal)
                put("name", rawPl.optString("name").trim().ifEmpty { "Çalma Listesi" }.take(200))
                put("cover", rawPl.optString("cover").ifEmpty { rawPl.optString("cover_url") }.take(2000))
                put("tracks", rawPl.optJSONArray("tracks") ?: JSONArray())
                val created = rawPl.optString("created_at").trim()
                if (isoRegex.matches(created)) put("created_at", created)
            }
            sanitizedPlaylists.put(cleanPl)
        }
        val payload = JSONObject().apply {
            put("p_playlists", sanitizedPlaylists)
            put("p_liked_tracks", likedTracks)
            put("p_listening_stats", listeningStats)
        }.toString()
        val res = call("POST", "/rest/v1/rpc/sync_sunify_account_data", payload, bearer = accessToken)
        if (res.code == 401 || res.code == 403) {
            throw AuthExpiredException("Oturum süresi doldu.")
        }
        if (res.code !in 200..299) {
            throw IllegalStateException("Bulut eşitlemesi kaydedilemedi (${res.code}).")
        }
        return JSONObject().put("success", true)
    }

    fun normalizeGlobalTrackKey(artist: String, title: String): String {
        val normArtist = artist.replace(Regex("[\\u00A0\\s]+"), " ").trim().lowercase(Locale.ROOT)
        val normTitle = title.replace(Regex("[\\u00A0\\s]+"), " ").trim().lowercase(Locale.ROOT)
        return "$normArtist|$normTitle"
    }

    private fun readOrInitBaseline(context: Context): JSONObject {
        val file = File(context.filesDir, BASELINE_FILE_NAME)
        val parsed = runCatching {
            if (file.exists()) JSONObject(file.readText(Charsets.UTF_8)) else null
        }.getOrNull()

        var dirty = parsed == null || parsed.optInt("epoch", 0) != GLOBAL_CHART_EPOCH
        val root = if (!dirty && parsed != null) parsed else JSONObject()
        root.put("epoch", GLOBAL_CHART_EPOCH)

        val counts = root.optJSONObject("counts") ?: JSONObject().also { root.put("counts", it); dirty = true }
        for ((k, v) in DEFAULT_EPOCH2_COUNTS) {
            if (!counts.has(k)) {
                counts.put(k, v)
                dirty = true
            }
        }
        if (root.optJSONObject("localCounts") == null) {
            root.put("localCounts", JSONObject())
            dirty = true
        }
        if (root.optJSONObject("trackMeta") == null) {
            root.put("trackMeta", JSONObject())
            dirty = true
        }
        if (dirty) writeBaseline(context, root)
        return root
    }

    private fun writeBaseline(context: Context, baseline: JSONObject) {
        runCatching {
            File(context.filesDir, BASELINE_FILE_NAME).writeText(baseline.toString(), Charsets.UTF_8)
        }
    }

    fun recordPlay(trackId: String, title: String, artist: String, thumbnail: String) {
        val payload = JSONObject().apply {
            put("track_id", trackId.take(200))
            put("track_title", title.take(300))
            put("track_artist", artist.take(300))
            put("track_thumbnail", thumbnail.take(1000))
        }.toString()
        runCatching { call("POST", "/rest/v1/rpc/record_sunify_play", payload) }
    }

    fun recordCompletedGlobalPlay(
        context: Context,
        trackId: String,
        title: String,
        artist: String,
        thumbnail: String
    ) {
        val key = normalizeGlobalTrackKey(artist, title)
        if (title.isNotBlank()) {
            synchronized(chartLock) {
                val baseline = readOrInitBaseline(context)
                val localCounts = baseline.getJSONObject("localCounts")
                localCounts.put(key, localCounts.optLong(key, 0L) + 1L)
                val metaMap = baseline.getJSONObject("trackMeta")
                metaMap.put(key, JSONObject().apply {
                    put("id", trackId.take(200))
                    put("title", title.take(300))
                    put("artist", artist.take(300))
                    put("thumbnail", thumbnail.take(1000))
                })
                writeBaseline(context, baseline)
            }
            recordPlay(trackId, title, artist, thumbnail)
        }
    }

    fun fetchChart(rpcName: String, limit: Int): JSONArray {
        val payload = JSONObject().put("result_limit", limit.coerceIn(1, 100)).toString()
        val res = call("POST", "/rest/v1/rpc/$rpcName", payload)
        if (res.code !in 200..299) return JSONArray()
        val raw = runCatching { JSONArray(res.body) }.getOrDefault(JSONArray())
        val out = JSONArray()
        for (i in 0 until raw.length()) {
            val row = raw.optJSONObject(i) ?: continue
            val t = row.optString("title")
            val a = row.optString("artist")
            out.put(JSONObject().apply {
                put("id", row.optString("track_id"))
                put("title", t)
                put("artist", a)
                put("thumbnail", row.optString("thumbnail"))
                put("playCount", row.optLong("play_count", 0))
                put("query", "$a $t".trim())
            })
        }
        return out
    }

    fun fetchResetGlobalTop(context: Context, limit: Int): JSONArray {
        val safeLimit = limit.coerceIn(1, 25)
        val rawList = fetchChart("get_sunify_global_top", 100)
        val merged = linkedMapOf<String, JSONObject>()

        synchronized(chartLock) {
            val baseline = readOrInitBaseline(context)
            val counts = baseline.getJSONObject("counts")
            val localCounts = baseline.getJSONObject("localCounts")
            val trackMeta = baseline.getJSONObject("trackMeta")
            var dirty = false

            for (i in 0 until rawList.length()) {
                val item = rawList.optJSONObject(i) ?: continue
                val title = item.optString("title")
                val artist = item.optString("artist")
                val key = normalizeGlobalTrackKey(artist, title)
                val rawCount = item.optLong("playCount", 0L)
                val localCount = localCounts.optLong(key, 0L)

                if (!counts.has(key) && rawCount > 1L && localCount == 0L) {
                    counts.put(key, rawCount)
                    dirty = true
                }

                val baseCount = if (counts.has(key)) counts.optLong(key, 0L) else 0L
                val netSupabase = (rawCount - baseCount).coerceAtLeast(0L)
                val effectiveCount = maxOf(netSupabase, localCount)
                if (effectiveCount >= 1L) {
                    item.put("playCount", effectiveCount)
                    val existing = merged[key]
                    if (existing == null || effectiveCount > existing.optLong("playCount", 0L)) {
                        merged[key] = item
                    }
                }
            }

            val localKeys = localCounts.keys()
            while (localKeys.hasNext()) {
                val key = localKeys.next()
                val localCount = localCounts.optLong(key, 0L)
                if (localCount < 1L) continue
                val existing = merged[key]
                if (existing != null) {
                    if (localCount > existing.optLong("playCount", 0L)) {
                        existing.put("playCount", localCount)
                    }
                    continue
                }
                val meta = trackMeta.optJSONObject(key) ?: continue
                val t = meta.optString("title")
                val a = meta.optString("artist")
                if (t.isBlank()) continue
                merged[key] = JSONObject().apply {
                    put("id", meta.optString("id"))
                    put("title", t)
                    put("artist", a)
                    put("thumbnail", meta.optString("thumbnail"))
                    put("playCount", localCount)
                    put("query", "$a $t".trim())
                }
            }

            if (dirty) writeBaseline(context, baseline)
        }

        val sorted = merged.values.sortedByDescending { it.optLong("playCount", 0L) }.take(safeLimit)
        val out = JSONArray()
        for (row in sorted) out.put(row)
        return out
    }
}

package com.sunify.mobile

import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

object ArtistService {

    private fun httpGetJson(url: String): JSONObject? {
        val req = Request.Builder().url(url).header("User-Agent", "SunifyMobile/1.2.1").build()
        return runCatching {
            OkHttpDownloader.sharedClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) null else JSONObject(res.body?.string().orEmpty())
            }
        }.getOrNull()
    }

    fun searchArtists(query: String): JSONArray {
        val enc = URLEncoder.encode(query, "UTF-8")
        val json = httpGetJson("https://itunes.apple.com/search?term=$enc&entity=musicArtist&limit=8")
            ?: return JSONArray()
        val results = json.optJSONArray("results") ?: return JSONArray()
        val out = JSONArray()
        for (i in 0 until minOf(6, results.length())) {
            val item = results.optJSONObject(i) ?: continue
            val name = item.optString("artistName")
            val albumJson = httpGetJson(
                "https://itunes.apple.com/search?term=${URLEncoder.encode(name, "UTF-8")}&entity=album&limit=1"
            )
            val art = albumJson?.optJSONArray("results")?.optJSONObject(0)?.optString("artworkUrl100")
                ?.replace("100x100bb", "600x600bb").orEmpty()
            out.put(JSONObject().apply {
                put("id", item.optLong("artistId"))
                put("name", name)
                put("genre", item.optString("primaryGenreName"))
                put("image", art)
            })
        }
        return out
    }

    fun getArtistProfile(artistId: String): JSONObject {
        val lookup = httpGetJson("https://itunes.apple.com/lookup?id=$artistId&entity=album&limit=12")
            ?: throw IllegalStateException("Sanatçı bulunamadı.")
        val results = lookup.optJSONArray("results") ?: JSONArray()
        var artistName = "Sanatçı"
        var genre = ""
        val albums = JSONArray()
        for (i in 0 until results.length()) {
            val row = results.optJSONObject(i) ?: continue
            when (row.optString("wrapperType")) {
                "artist" -> {
                    artistName = row.optString("artistName", artistName)
                    genre = row.optString("primaryGenreName")
                }
                "collection" -> {
                    albums.put(JSONObject().apply {
                        put("id", row.optLong("collectionId"))
                        put("title", row.optString("collectionName"))
                        put("image", row.optString("artworkUrl100").replace("100x100bb", "600x600bb"))
                        put("year", row.optString("releaseDate").take(4))
                    })
                }
            }
        }
        val tracksLookup = httpGetJson("https://itunes.apple.com/lookup?id=$artistId&entity=song&limit=20")
        val tracks = JSONArray()
        val tRes = tracksLookup?.optJSONArray("results") ?: JSONArray()
        for (i in 0 until tRes.length()) {
            val row = tRes.optJSONObject(i) ?: continue
            if (row.optString("wrapperType") != "track") continue
            val tName = row.optString("trackName")
            val aName = row.optString("artistName", artistName)
            tracks.put(JSONObject().apply {
                put("id", "")
                put("title", tName)
                put("artist", aName)
                put("thumbnail", row.optString("artworkUrl100").replace("100x100bb", "600x600bb"))
                put("duration", row.optLong("trackTimeMillis") / 1000L)
                put("albumId", row.optLong("collectionId"))
                put("query", "$aName $tName".trim())
            })
        }
        val image = albums.optJSONObject(0)?.optString("image").orEmpty()
        return JSONObject().apply {
            put("artist", JSONObject().apply {
                put("id", artistId)
                put("name", artistName)
                put("genre", genre)
                put("image", image)
                put("bio", "$artistName sanatçısının popüler şarkıları ve albümleri.")
            })
            put("albums", albums)
            put("tracks", tracks)
        }
    }
}

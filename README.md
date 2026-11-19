<div align="center">

# ☀️ Sunify Mobile

**Android için kapak rengine uyarlanan, sıvı cam (*Liquid Glass*) tasarımlı yeni nesil müzik çalar**

10 Bantlı Ekolayzer & Canlı Efektler · Sunify Connect & Jam Odası · Kelime Senkronize Şarkı Sözleri · Yerel Widget & Çevrimdışı İndirme

[![Platform](https://img.shields.io/badge/Platform-Android%208.0%2B%20(API%2026)-3DDC84?style=flat-square&logo=android&logoColor=white)](https://developer.android.com)
[![Kotlin](https://img.shields.io/badge/Kotlin-2.0.21-7F52FF?style=flat-square&logo=kotlin&logoColor=white)](https://kotlinlang.org/)
[![Gradle](https://img.shields.io/badge/Gradle-8.11.1-02303A?style=flat-square&logo=gradle&logoColor=white)](https://gradle.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-a78bfa?style=flat-square)](LICENSE)

> 🖥️ **Masaüstü Sürümü:** Windows masaüstü uygulaması için [Kadir-72I/Sunify](https://github.com/Kadir-72I/Sunify) deposuna göz atabilirsiniz. İki uygulama **Supabase** ve **Sunify Connect** üzerinden gerçek zamanlı eşitlenir.

</div>

---

## ✨ Öne Çıkan Özellikler

### 🎨 Kapak Rengine Uyarlanan Liquid Glass Arayüzü
- Çalan şarkının albüm kapağını HSV ton sepetleriyle analiz eden yerel motor sayesinde üst çubuk, cam kartlar, mini oynatıcı, alt dock, ortam ışıkları ve tam ekran arka plan kapağın rengine göre dinamik değişir.
- **Sunify / Karanlık / Açık** tema seçenekleri ve Ayarlar’dan **Oto (Kapak Rengi)** veya sabit vurgu renkleri (*Mor, Pembe, Mavi, Zümrüt*).

### 🎛️ 10 Bantlı Ekolayzer & Canlı Ses Efektleri
- Web Audio API tabanlı **10 bantlı ekolayzer** (`32Hz – 16kHz`) ve 7 hazır profil (*Düz, Bas, Vokal, Akustik, Gece, Elektronik, Tiz*).
- **Hız, Perde & Mood Profilleri**: Tek dokunuşla **Slowed + Reverb**, **Nightcore**, **Chill** veya **Normal** modları; `0.75x – 1.35x` hız ayarı, perde kilidi (*Pitch Lock*) ve `ConvolverNode` reverb yoğunluğu.
- **Ses Normalizasyonu, Crossfade & Uyku Zamanlayıcısı**: Parçalar arası ses dengeleme, `0–10 sn` yumuşak geçiş, **15 / 30 / 45 / 60 dk** veya **Şarkı Bitince** moduyla kademeli ses kısarak durdurma.
- **Canlı Ses Görselleştirici**: Şimdi Çalıyor ekranında kapağın altında müziğin ritmine göre hareket eden dinamik spektrum çubukları.

### 🎤 Kelime Senkronize Şarkı Sözleri, Çeviri & Söz Kartları
- **Çok Kaynaklı Arama Motoru**: `LRCLIB`, `NetEase`, `KuGou`, `Genius`, `LyricsOVH` ve Türkçe kaynaklar arasında otomatik en iyi sonucu seçer; manuel kaynak değiştirme ve `±0.5 sn` gecikme ayarı sunar.
- **Tek Dokunuşla Türkçe Çeviri**: Yabancı parçalarda her satırın altında isteğe bağlı Türkçe çeviri gösterir.
- **Paylaşılabilir Söz Kartları (`1080×1350`)**: Şarkı sözlerinden `1–4` satır seçip bulanık kapaklı Liquid Glass PNG kartı oluşturarak Android paylaşım menüsünden doğrudan paylaşın.

### 📡 Sunify Connect & Jam (Ortak Dinleme Odası)
- **Cihazlar Arası Kontrol & Aktarım**: Aynı hesapla açık olan PC ve Android cihazlarını anlık görür; telefondan bilgisayardaki müziği yönetip sesini ayarlayabilir veya **"Telefona Al / Cihaza Aktar"** ile kaldığınız saniyeden devam edebilirsiniz.
- **Jam Odası**: `SNF...` oda koduyla arkadaşınızla aynı anda senkronize dinleyin ve ortak sıraya şarkı ekleyin.

### 📱 Android’e Özel Yerel Deneyimler
- **Kilit Ekranı, Bildirim & Araç Kontrolü**: Yüksek çözünürlüklü albüm kapağı, etkileşimli **sarma çubuğu (Seekbar)**, doğrudan **Beğen** tuşu ve Bluetooth / araç ekranı için süre bilgisi; kulaklık çıktığında otomatik duraklatma (`ACTION_AUDIO_BECOMING_NOISY`).
- **Ana Ekran Liquid Glass Widget’ı**: Çalan parçayı, kapağı ve oynatma kontrollerini telefon ana ekranına taşıyan kapak renkli widget.
- **Çevrimdışı İndirme & Wi-Fi Koruması**: Tek parça veya tüm çalma listesini tek tuşla indirme ve Ayarlar’dan **Yalnızca Wi-Fi'da İndir** seçeneği.
- **Spotify & YouTube İçe Aktarma + Özel Liste Düzenleme**: Playlist URL’sini yapıştırarak yüksek çözünürlüklü kapaklarla içe aktarma, galeriden özel kapak seçme, açıklama ekleme ve sıralama.

### 📊 Dinleme Özeti (Wrapped), Seri & 70 Günlük Isı Haritası
- Yalnızca ileri sarmadan sonuna kadar dinlenen parçaları sayan kişisel analiz ve masaüstüyle ortak sıfırlanmış global liste.
- **5 Günlük Mix**, günlük dinleme hedefi (`30 / 60 / 90 dk`), kesintisiz **seri** sayacı, 70 günlük takvim ısı haritası ve `1080×1920` Hikaye formatında paylaşılabilir **Sunify Özet Kartı**.

---

## 👆 Dokunma Jestleri

| Konum | Hareket | İşlev |
| :--- | :--- | :--- |
| **Mini Oynatıcı** | Sola / Sağa kaydır | Sonraki / Önceki parça |
| **Mini Oynatıcı** | Yukarı kaydır *(veya dokun)* | Tam ekran Şimdi Çalıyor ekranını aç |
| **Şarkı Satırı** | Sağa kaydır | **Sıradaki Çal** (hemen sonraki parça olarak sıraya ekle) |
| **Şarkı Sözleri** | Satıra dokun | Şarkıyı doğrudan o saniyeye sar |
| **Şarkı Sözleri *(Kart Modu)*** | `1–4` satıra dokun | Paylaşılabilir Şarkı Sözü Kartı satırlarını seç |

---

## 🚀 Proje Mimarisi

```text
Sunify-Mobile/
├── app/
│   ├── build.gradle.kts                  # Uygulama bağımlılıkları (SDK 35, NewPipeExtractor, NanoHTTPD)
│   └── src/main/
│       ├── AndroidManifest.xml           # Servisler, FileProvider ve Ana Ekran Widget tanımları
│       ├── assets/renderer/              # Hibrit Liquid Glass WebView arayüzü ve ortak modüller
│       │   ├── mobile.html               # Mobil arayüz iskeleti
│       │   ├── mobile-app.css            # Dinamik Liquid Glass stil katmanı
│       │   ├── mobile-app.js             # Oynatıcı, jestler, kitaplık, çevrimdışı indirme ve senkronizasyon
│       │   ├── sunify-audio-fx.js        # 10 bant EQ, reverb, hız/perde, crossfade, uyku ve görselleştirici
│       │   ├── sunify-realtime.js        # Supabase Realtime Connect & Jam WebSocket istemcisi
│       │   ├── sunify-cards.js           # Wrapped/Söz kartı PNG üreticisi ve 70 günlük ısı haritası
│       │   ├── sunify-features.css       # Ortak özellik stilleri
│       │   ├── lyricsTiming.js           # LRC kelime bazlı zamanlama çözücü
│       │   └── vendor/                   # Yerel FontAwesome ve Inter font dosyaları
│       ├── kotlin/com/sunify/mobile/
│       │   ├── MainActivity.kt           # WebView + JS Bridge, galeri seçici, Wi-Fi ve PNG paylaşım köprüsü
│       │   ├── LocalApiServer.kt         # 127.0.0.1:3001 NanoHTTPD ses akışı, çeviri, görsel proxy ve renk analizi
│       │   ├── YouTubeAudioService.kt    # NewPipeExtractor ile akış çözümleme ve yerel önbellek/indirme
│       │   ├── LyricsService.kt          # Çok kaynaklı şarkı sözü arama motoru
│       │   ├── ArtistService.kt          # Sanatçı arama ve diskografi servisi
│       │   ├── SupabaseSyncService.kt    # Hesap eşitleme ve sıfırlanmış global liste
│       │   ├── MediaPlaybackService.kt   # Ön plan medya servisi, kilit ekranı seekbar ve kulaklık koruması
│       │   ├── SunifyWidgetProvider.kt   # Ana ekran Liquid Glass müzik widget'ı
│       │   ├── OkHttpDownloader.kt       # Ortak HTTP istemcisi
│       │   └── SunifyApplication.kt      # Arka plan yerel sunucu yaşam döngüsü
│       └── res/                          # İkonlar, widget yerleşimi ve dosya sağlayıcı yolları
├── gradle/wrapper/                       # Gradle Wrapper (8.11.1)
├── build.gradle.kts                      # Kök Gradle yapılandırması
└── settings.gradle.kts
```

---

## 🛠️ Kurulum & Derleme

Bu depo dış masaüstü kaynaklarına bağlı olmadan **tek başına** derlenebilir yapıdadır.

### Gereksinimler
- **JDK 17**
- **Android SDK** (`compileSdk 35`, `minSdk 26 / Android 8.0+`)

### Komut Satırı ile APK Derleme
```bash
git clone https://github.com/Kadir-72I/Sunify-Mobile.git
cd Sunify-Mobile

# Debug APK oluşturma (Windows için .\gradlew.bat assembleDebug)
./gradlew assembleDebug
```
Üretilen APK dosyası `app/build/outputs/apk/debug/app-debug.apk` yolunda oluşturulur.

### Android Studio ile Açma
1. Android Studio’da **Open** seçeneğiyle `Sunify-Mobile` klasörünü açın.
2. Gradle senkronizasyonunun tamamlanmasını bekleyin ve cihazınızda veya emülatörde **Run (`Shift+F10`)** ile başlatın.

---

## 📄 Lisans

Bu proje [MIT Lisansı](LICENSE) ile lisanslanmıştır.

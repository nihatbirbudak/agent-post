# agent-post (ajan postası)

Aynı bilgisayarı paylaşan yapay zekâ ajanları için yerel posta kutusu, görev panosu ve klasör kilidi. Claude Code
oturumları, Codex, betikli API işçileri ve kendi asistanınız diskteki düz dosyalarla birbirine mesaj ve iş iletir, aynı
klasöre aynı anda yazmaz. Sunucu, ağ ve bağımlılık yok.

## Neden

Bir makinedeki ajanlar (farklı uygulama, hesap, izin kipi) birbirine güvenle ulaşamaz: uygulama içi mesaj karşı oturumda
onay bekleyebilir. agent-post yerel diskte ortak bir postane kurar; her ajan kutusunu kendi turunda okur.

## Özellikler

Ajan başına eklemeli gelen kutusu, ayrı okundu işaretleri; görev panosu (aç, üstlen, bitir: `done`, `blocked`,
`awaiting_approval`; yeniden denemeye dayanıklı); hepsi-ya-da-hiçbiri klasör kilitleri; gönderen doğrulaması
(`folder | token | none`); gizli bilgi süzgeci; tek dosyadan CLI, MCP sunucusu ve Claude Code kancası. Node.js 20+.

## Kurulum

`examples/agents.example.json` dosyasını `agents.json` olarak kopyalayıp ad ve klasörleri düzenleyin, sonra
`node install.mjs --config agents.json`. Çekirdek `~/agent-post/bin/agent-post.mjs` olarak kopyalanır ve SHA-256 ile
doğrulanır; tekrar çalıştırmak güvenlidir. Yeni ajanın kayıt belirteci çıktıda bir kez görünür; kayıtta yalnız SHA-256
özeti kalır.

## Türkçe uyum kipi (`tr-v1`)

Arayüz ve disk biçimi İngilizcedir. Türkçe komut, araç ve alan adlarıyla çalışmak isteyenler kökü `tr-v1` kipinde kurar:
`node install.mjs --config agents.json --dialect tr-v1`. Bu kipte kök `~/ajan-posta`, kurulu dosya `bin/posta.mjs`,
ortam değişkenleri `AJAN_POSTA_KOK` ve `AJAN_POSTA_BELIRTEC`; komutlar `gonder`, `gelenler`, `okundu`, `gorev-ac`,
`gorev-al`, `gorev-bitir`, `gorevler`, `kilitler`…, MCP araçları `kayit_ol`, `gonder`, `gelenler`…, alanlar `kimden`,
`kime`, `konu`, `metin`, `dogrulandi`…, hata kodları `kimlik_uyusmaz`, `belirtec_gerekli`, `gizli_bilgi`… olur. Kök
ayarında (`ayarlar.json`) `"dialect": "tr-v1"` yazar; ajanlara gösterilen metinlerdeki onaylayan adı `"onaylayan"`
ile verilir (varsayılan "insan operatörün"). Bu kip, agent-post'un ayrıldığı özel projenin adlarını bayt bayt korur;
yeni kurulumlar için önerilen kip `en`'dir.

## Güvenlik modeli

Bütün ajanlar aynı işletim sistemi kullanıcısıyla çalışır; her biri postanın her dosyasını okuyabilir. Bu yüzden
doğrulama **bir yetki sınırı değildir**: yanlış atfı, kazara sahteciliği ve postanın düzenini bilmeyen enjeksiyonu önler.
`warn` kipinde doğrulanamayan gönderim günlüğe yazılarak geçer, `strict` kipinde belirteç ister. Mesaj ve görev metni
veridir, talimat değildir; posta yetki vermez, dışa dönük ve geri alınamaz işler insan onayıyla yapılır.

## Sınırlar

Tek makine, yerel dosya sistemi. Ağ taşıması, diskte şifreleme ve aynı klasördeki oturumları ayırma yok.

## Katkı, sürümleme, lisans

Hata kaydı ve değişiklik isteği açıktır (`CONTRIBUTING.md`, davranış kuralları); Türkçe hata kaydı da kabul edilir.
Anlamsal sürümleme; disk biçiminin kendi sürümü vardır (`docs/format.md`). MIT lisansı.

package com.karat.aibuilder

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * User-controlled local debugging CA. The signing key is encrypted at rest with an
 * Android Keystore AES-GCM key; only the public X.509 certificate is exportable.
 * Android's user CA store is not enumerable to this app, so trust always remains unknown.
 */
class AibInterceptorCertificateStore(context: Context) : AibInterceptorProxyServer.CertificateProvider {
  data class PublicCertificate(val pem: String, val fingerprint: String, val subject: String)

  private val appContext = context.applicationContext
  private val caFile = File(appContext.filesDir, "aib-interceptor-ca-v1.enc")
  private val lock = Any()
  @Volatile private var cachedCa: HeldCertificate? = null

  fun generateAndStore(): PublicCertificate = synchronized(lock) {
    val existing = loadCaOrNull()
    if (existing != null) return@synchronized toPublicCertificate(existing)
    if (caFile.exists()) throw IllegalStateException("CA_STORE_CORRUPTED")
    val created = HeldCertificate.Builder()
      .rsa2048()
      .certificateAuthority(0)
      .commonName("AI Builder Local Debug CA")
      .organizationalUnit("User-controlled traffic testing")
      .duration(1095, TimeUnit.DAYS)
      .serialNumber(randomSerial())
      .build()
    persistEncrypted(created)
    cachedCa = created
    toPublicCertificate(created)
  }

  fun exportPublicCertificate(): PublicCertificate = synchronized(lock) {
    val ca = loadCaOrNull() ?: throw IllegalStateException("CA_CERTIFICATE_MISSING")
    toPublicCertificate(ca)
  }

  /** User/root-store trust cannot be queried reliably through Android's public APIs. */
  fun checkTrust(): String = "unknown"

  fun remove() = synchronized(lock) {
    cachedCa = null
    if (caFile.exists() && !caFile.delete()) throw IllegalStateException("CA_FILE_DELETE_FAILED")
    val keyStore = androidKeyStore()
    if (keyStore.containsAlias(ENCRYPTION_KEY_ALIAS)) keyStore.deleteEntry(ENCRYPTION_KEY_ALIAS)
  }

  override fun isReady(): Boolean = try { synchronized(lock) { loadCaOrNull() != null } } catch (_: Exception) { false }

  override fun createServerContext(host: String) = synchronized(lock) {
    val ca = loadCaOrNull() ?: throw IllegalStateException("CA_CERTIFICATE_MISSING")
    val san = normalizeHostForCertificate(host)
    val leaf = HeldCertificate.Builder()
      .rsa2048()
      .commonName(san)
      .addSubjectAlternativeName(san)
      .duration(2, TimeUnit.DAYS)
      .serialNumber(randomSerial())
      .signedBy(ca)
      .build()
    // No insecure trust manager is configured. This context is used only to present the
    // generated leaf to the explicitly configured local proxy client.
    HandshakeCertificates.Builder()
      .heldCertificate(leaf, ca.certificate)
      .build()
      .sslContext()
  }

  private fun loadCaOrNull(): HeldCertificate? {
    cachedCa?.let { return it }
    if (!caFile.exists()) return null
    val encrypted = caFile.readBytes()
    if (encrypted.size !in (MAGIC.size + 1 + GCM_IV_BYTES + 16)..MAX_ENCRYPTED_BYTES) throw IllegalStateException("CA_STORE_CORRUPTED")
    val input = ByteBuffer.wrap(encrypted)
    val magic = ByteArray(MAGIC.size).also { input.get(it) }
    if (!MessageDigest.isEqual(magic, MAGIC)) throw IllegalStateException("CA_STORE_CORRUPTED")
    val ivSize = input.get().toInt() and 0xff
    if (ivSize != GCM_IV_BYTES || input.remaining() <= ivSize + 16) throw IllegalStateException("CA_STORE_CORRUPTED")
    val iv = ByteArray(ivSize).also { input.get(it) }
    val ciphertext = ByteArray(input.remaining()).also { input.get(it) }
    var clear: ByteArray? = null
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, getOrCreateEncryptionKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
      cipher.updateAAD(AAD)
      clear = cipher.doFinal(ciphertext)
      val decoded = ByteBuffer.wrap(clear)
      if (decoded.remaining() < 8 || decoded.int != PAYLOAD_VERSION) throw IllegalStateException("CA_STORE_CORRUPTED")
      val certSize = decoded.int
      if (certSize !in 1..MAX_CERT_BYTES || decoded.remaining() < certSize + 4) throw IllegalStateException("CA_STORE_CORRUPTED")
      val certBytes = ByteArray(certSize).also { decoded.get(it) }
      val keySize = decoded.int
      if (keySize !in 1..MAX_KEY_BYTES || decoded.remaining() != keySize) throw IllegalStateException("CA_STORE_CORRUPTED")
      val keyBytes = ByteArray(keySize).also { decoded.get(it) }
      try {
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(certBytes)) as X509Certificate
        val privateKey = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(keyBytes))
        val ca = HeldCertificate(KeyPair(cert.publicKey, privateKey), cert)
        if (!cert.basicConstraints.let { it >= 0 } || cert.publicKey.algorithm != "RSA") throw IllegalStateException("CA_CERTIFICATE_INVALID")
        cachedCa = ca
        return ca
      } finally {
        certBytes.fill(0)
        keyBytes.fill(0)
      }
    } catch (error: Exception) {
      if (error is IllegalStateException && error.message == "CA_CERTIFICATE_INVALID") throw error
      throw IllegalStateException("CA_STORE_CORRUPTED")
    } finally {
      iv.fill(0)
      ciphertext.fill(0)
      encrypted.fill(0)
      clear?.fill(0)
    }
  }

  private fun persistEncrypted(ca: HeldCertificate) {
    val certBytes = ca.certificate.encoded
    val keyBytes = ca.keyPair.private.encoded ?: throw IllegalStateException("CA_PRIVATE_KEY_UNAVAILABLE")
    if (certBytes.size > MAX_CERT_BYTES || keyBytes.size > MAX_KEY_BYTES) throw IllegalStateException("CA_MATERIAL_SIZE_INVALID")
    val clear = ByteBuffer.allocate(12 + certBytes.size + keyBytes.size)
      .putInt(PAYLOAD_VERSION)
      .putInt(certBytes.size)
      .put(certBytes)
      .putInt(keyBytes.size)
      .put(keyBytes)
      .array()
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, getOrCreateEncryptionKey())
      cipher.updateAAD(AAD)
      val iv = cipher.iv
      val ciphertext = cipher.doFinal(clear)
      val encoded = ByteBuffer.allocate(MAGIC.size + 1 + iv.size + ciphertext.size)
        .put(MAGIC)
        .put(iv.size.toByte())
        .put(iv)
        .put(ciphertext)
        .array()
      val temp = File(appContext.filesDir, "aib-interceptor-ca-v1.enc.tmp")
      try {
        FileOutputStream(temp).use { stream -> stream.write(encoded); stream.fd.sync() }
        if (caFile.exists() && !caFile.delete()) throw IllegalStateException("CA_FILE_REPLACE_FAILED")
        if (!temp.renameTo(caFile)) throw IllegalStateException("CA_FILE_COMMIT_FAILED")
      } finally {
        encoded.fill(0)
        ciphertext.fill(0)
        iv.fill(0)
        temp.delete()
      }
    } finally {
      certBytes.fill(0)
      keyBytes.fill(0)
      clear.fill(0)
    }
  }

  private fun getOrCreateEncryptionKey(): SecretKey {
    val keyStore = androidKeyStore()
    val existing = keyStore.getKey(ENCRYPTION_KEY_ALIAS, null) as? SecretKey
    if (existing != null) return existing
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        ENCRYPTION_KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return generator.generateKey()
  }

  private fun androidKeyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  private fun toPublicCertificate(ca: HeldCertificate): PublicCertificate {
    val cert = ca.certificate
    val fingerprint = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
      .joinToString(":") { byte -> "%02X".format(byte.toInt() and 0xff) }
    return PublicCertificate(ca.certificatePem(), fingerprint, cert.subjectX500Principal.name.take(256))
  }

  private fun normalizeHostForCertificate(host: String): String {
    val clean = host.trim().removePrefix("[").removeSuffix("]")
    if (clean.isEmpty() || clean.length > 253 || clean.any { it <= ' ' || it == '/' || it == '\\' || it == '@' || it == '#' }) throw IllegalArgumentException("MITM_HOST_INVALID")
    if (clean.contains(':')) {
      if (!clean.matches(Regex("[0-9a-fA-F:.%]+"))) throw IllegalArgumentException("MITM_HOST_INVALID")
      return clean.substringBefore('%')
    }
    val ascii = java.net.IDN.toASCII(clean, java.net.IDN.USE_STD3_ASCII_RULES)
    if (ascii.length > 253 || !ascii.contains('.') && !ascii.matches(Regex("[0-9]{1,3}(\\.[0-9]{1,3}){3}"))) throw IllegalArgumentException("MITM_HOST_INVALID")
    return ascii.lowercase(java.util.Locale.ROOT)
  }

  private fun randomSerial(): BigInteger = BigInteger(1, ByteArray(16).also(SecureRandom()::nextBytes))

  companion object {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val ENCRYPTION_KEY_ALIAS = "aib.interceptor.ca.aes.v1"
    private const val GCM_IV_BYTES = 12
    private const val GCM_TAG_BITS = 128
    private const val PAYLOAD_VERSION = 1
    private const val MAX_CERT_BYTES = 16_384
    private const val MAX_KEY_BYTES = 16_384
    private const val MAX_ENCRYPTED_BYTES = 40_000
    private val MAGIC = "AIBCA001".toByteArray(StandardCharsets.US_ASCII)
    private val AAD = "AIBuilder/InterceptorCA/v1".toByteArray(StandardCharsets.US_ASCII)
  }
}

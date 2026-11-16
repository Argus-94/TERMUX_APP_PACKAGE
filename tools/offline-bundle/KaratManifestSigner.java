package com.karat.aibuilder.offline;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.Key;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.util.Arrays;

/** Detached offline manifest signature: exact raw bytes, JCA SHA256withRSA (PKCS#1 v1.5). */
public final class KaratManifestSigner {
    public static final String EXPECTED_CERT_SHA256 = "b5dacc6f9c37adceace5c0d715eecb2762b5a0417468e221ec9c534ea1e6328e";
    public static final String ALIAS = "karat";
    private KaratManifestSigner() {}

    static String sha256(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder(64);
        for (byte value : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }
    static boolean verify(byte[] rawManifest, byte[] signature, X509Certificate certificate) throws Exception {
        return verify(rawManifest, signature, certificate.getPublicKey());
    }
    static boolean verify(byte[] rawManifest, byte[] signature, PublicKey publicKey) throws Exception {
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(publicKey);
        verifier.update(rawManifest);
        return verifier.verify(signature);
    }
    static byte[] sign(byte[] rawManifest, PrivateKey key) throws Exception {
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(key);
        signer.update(rawManifest);
        return signer.sign();
    }
    static byte[] readBounded(Path path, int maximum) throws Exception {
        long size = Files.size(path);
        if (size < 1 || size > maximum) throw new IllegalArgumentException("input_size_invalid");
        return Files.readAllBytes(path);
    }
    private static char[] envPassword(String key) {
        String value = System.getenv(key);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("required_environment_missing:" + key);
        return value.toCharArray();
    }
    private static X509Certificate pinnedCertificate(KeyStore store) throws Exception {
        if (!store.containsAlias(ALIAS)) throw new IllegalArgumentException("signer_alias_missing");
        X509Certificate certificate = (X509Certificate) store.getCertificate(ALIAS);
        if (certificate == null || !"RSA".equalsIgnoreCase(certificate.getPublicKey().getAlgorithm()) ||
                !EXPECTED_CERT_SHA256.equals(sha256(certificate.getEncoded()))) {
            throw new IllegalArgumentException("signer_certificate_pin_mismatch");
        }
        return certificate;
    }
    private static KeyStore loadStore(Path path, char[] password) throws Exception {
        KeyStore store = KeyStore.getInstance("JKS");
        try (FileInputStream input = new FileInputStream(path.toFile())) { store.load(input, password); }
        return store;
    }
    private static void sign(Path storePath, Path manifestPath, Path signaturePath) throws Exception {
        char[] storePassword = envPassword("AIB_KARAT_STORE_PASSWORD");
        char[] keyPassword = envPassword("AIB_KARAT_KEY_PASSWORD");
        try {
            KeyStore store = loadStore(storePath, storePassword);
            X509Certificate certificate = pinnedCertificate(store);
            Key key = store.getKey(ALIAS, keyPassword);
            if (!(key instanceof PrivateKey) || !"RSA".equalsIgnoreCase(key.getAlgorithm())) throw new IllegalArgumentException("signer_private_key_invalid");
            byte[] raw = readBounded(manifestPath, 192 * 1024);
            byte[] signature = sign(raw, (PrivateKey) key);
            if (signature.length != 128 || !verify(raw, signature, certificate)) throw new IllegalStateException("signer_output_verification_failed");
            Files.write(signaturePath, signature);
        } finally { Arrays.fill(storePassword, '\0'); Arrays.fill(keyPassword, '\0'); }
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 4 || !"sign".equals(args[0])) {
            System.err.println("Usage: KaratManifestSigner sign <JKS> <manifest.json> <manifest.sig>");
            System.exit(2);
        }
        sign(Path.of(args[1]), Path.of(args[2]), Path.of(args[3]));
    }
}

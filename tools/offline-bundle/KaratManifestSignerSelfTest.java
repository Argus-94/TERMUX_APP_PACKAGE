package com.karat.aibuilder.offline;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Arrays;

public final class KaratManifestSignerSelfTest {
    public static void main(String[] args) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(1024);
        KeyPair signer = generator.generateKeyPair();
        KeyPair other = generator.generateKeyPair();
        byte[] manifest = "{\"format\":\"aibuilder-offline-package-bundle\",\"schemaVersion\":2}".getBytes(StandardCharsets.UTF_8);
        byte[] first = KaratManifestSigner.sign(manifest, signer.getPrivate());
        byte[] second = KaratManifestSigner.sign(manifest, signer.getPrivate());
        if (first.length != 128 || !Arrays.equals(first, second)) throw new AssertionError("signature_not_deterministic_or_wrong_size");
        if (!KaratManifestSigner.verify(manifest, first, signer.getPublic())) throw new AssertionError("valid_signature_rejected");
        byte[] tampered = manifest.clone(); tampered[tampered.length - 2] ^= 1;
        if (KaratManifestSigner.verify(tampered, first, signer.getPublic())) throw new AssertionError("tampered_manifest_accepted");
        byte[] damaged = first.clone(); damaged[0] ^= 1;
        if (KaratManifestSigner.verify(manifest, damaged, signer.getPublic())) throw new AssertionError("tampered_signature_accepted");
        if (KaratManifestSigner.verify(manifest, first, other.getPublic())) throw new AssertionError("wrong_certificate_key_accepted");
        System.out.println("KARAT_MANIFEST_SIGNER_SELFTEST_OK algorithm=SHA256withRSA encoding=raw-detached signatureBytes=128 deterministic=true tamperRejected=true wrongKeyRejected=true");
    }
}

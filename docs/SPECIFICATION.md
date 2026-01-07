# RCEP™ Specification (Normative)

This document defines the **normative** requirements for RCEP™ payloads produced by the RL4 Snapshot Chrome extension.

Terminology uses RFC 2119 keywords: **MUST**, **SHOULD**, **MAY**, **MUST NOT**.

## 1. Canonicalization (MUST)
To compute `checksum`, implementations MUST canonicalize the JSON object as follows:
- Objects: recursively sort keys lexicographically.
- Arrays: preserve order.
- Strings: preserved as-is (no whitespace normalization).
- Output: `JSON.stringify(canonicalized_object)` (no pretty printing).

The `checksum` field itself MUST be set to an empty string (or omitted) during checksum computation.

## 2. Checksum (MUST)
- `checksum` MUST be SHA-256 over the canonicalized payload (excluding `checksum` itself).
- Output MUST be lowercase hex (64 chars).

## 3. Common fields (all profiles)
All profiles MUST include:
- `protocol` (string)
- `session_id` (string)
- `timestamp` (ISO-8601 string)
- `_branding` (object, human-visible header)
- `producer` (object, machine-readable producer metadata)
- `checksum` (string)

Profiles MAY include:
- `signature` (object, device-only integrity seal)

## 4. UltraPlus semantic honesty (MUST)
If `protocol` is `RCEP_v2_UltraPlus`, the payload MUST include:
- `semantic_validation` with:
  - `status` = `unverified`
  - `scope` = `structure_only`
  - `reason` describing lack of transcript
  - `recommended_checks` (array of strings, min 1)

## 5. Device-only Integrity Seal (MAY)
If a payload includes `signature`:
- `signature.signed_payload` MUST be exactly `checksum:<checksumHex>`.
- `signature.value` MUST be a Base64-encoded ECDSA signature over `signed_payload` using P-256 + SHA-256.
- `signature.public_key_spki` MUST be Base64-encoded SPKI public key bytes.
- `signature.key_id` SHOULD be the SHA-256 hex digest of the SPKI bytes.

## 6. Unknowns (UltraPlus)
`unknowns` MUST be an array of objects:
- `term` (string)
- `reason` (string)

## 7. Reference JSON Schemas
See the `schemas/` directory:
- `rcep_v1_digest.schema.json`
- `rcep_v2_ultra.schema.json`
- `rcep_v2_ultra_plus.schema.json`
- `signature_device_integrity_v1.schema.json`



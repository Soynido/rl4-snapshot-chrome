# Security Model (Public)

RCEP™ payloads target **portability + integrity** for cross‑LLM context transfer.

This document describes what is guaranteed, what is not, and why.

## Guarantees
### 1) Checksum (SHA‑256)
If a payload includes `checksum` computed over the canonicalized JSON, then:
- Any modification to any field changes the checksum.
- A verifier can detect tampering by recomputing and comparing.

### 2) Integrity Seal (device-only, offline)
If a payload includes `signature`:
- The payload is tamper-evident **and** bound to a stable `key_id` (device continuity).
- A verifier can validate:
  - `signed_payload` equals `checksum:<hex>`
  - the signature verifies against the provided `public_key_spki`

## Non-guarantees (explicit)
- **No human identity proof**: “device-only” does not identify a person.
- **No notarization**: there is no third-party timestamping or HSM-backed signing.
- **No semantic truth validation**: without transcript/evidence, correctness is not guaranteed.
- **No protection against a compromised device**: a compromised environment can sign malicious content.

## Threats & mitigations
- **Accidental edits** → detected by checksum/signature mismatch.
- **Malicious edits** → detected by checksum/signature mismatch.
- **Replay of old context** → mitigated only by consumer-side logic (timestamps + domain checks).
- **Compromised signer** → not mitigated in device-only mode.



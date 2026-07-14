# Artifact completeness guarantees and limits

Artifact publication and staging recovery use byte-count evidence and bounded container parsing to reject many truncated or malformed media files. These checks establish only the properties described below. They do not prove that a file contains every byte the upstream producer intended, that its semantic content is correct, or that the producer itself is trustworthy.

## HTTP length evidence

The worker accepts `Content-Length` only as an exact decoded-body length when `Content-Encoding` is absent or exactly `identity`. In that case it records the value as trusted `expectedSizeBytes`; the writer must receive exactly that many decoded bytes, and recovery rechecks the recorded value before publication.

For any non-identity `Content-Encoding`, `Content-Length` describes the transferred representation and is not bound to the decoded response body. It is used only for an early transfer-size upper-bound check. The decoded stream still has its configured maximum-size limit and must pass the applicable container-structure checks.

Missing `Content-Length` is allowed. It removes exact external byte-count evidence; maximum-size and structural checks still apply.

## WAV boundary

WAV validation supports `RIFF`/`WAVE` files only. The RIFF declaration must end exactly at the file boundary, every chunk and required odd-byte pad must fit, and the file must contain one reasonable fmt chunk followed by one non-empty `data` chunk. PCM, IEEE float, and extensible formats receive additional block-alignment and byte-rate checks.

`RF64` and big-endian `RIFX` are not supported and are rejected.

## MP3 boundary

MP3 validation supports MPEG-1, MPEG-2, and MPEG-2.5 Layer I, II, and III frames with declared, non-free-format bitrates. Frame version, layer, and sample rate must remain consistent, and frames must traverse exactly to the accepted audio boundary with no partial frame or unexplained trailing bytes.

The accepted metadata placement is deliberately narrow:

- One optional ID3v2 block may appear only at the beginning. Its synchsafe declared extent is bounded; an indicated ID3v2.4 footer is included in that extent check. Tag payload semantics are not validated.
- One optional 128-byte ID3v1 tag may appear only at the end.
- APE tags and other leading or trailing tag formats are not supported. In particular, bytes after the last MPEG frame are rejected unless they are the recognized terminal ID3v1 tag.

When a Layer III first frame contains a recognized Xing/Info or VBRI declaration, declared frame and byte counts must match the parsed stream. This is useful truncation evidence, but it is not present in every valid MP3.

### Unavoidable exact-frame limitation

If an MP3 has no trusted `Content-Length` evidence and no Xing, Info, or VBRI length/count declaration, a truncation that lands exactly on a complete MPEG frame boundary is structurally indistinguishable from a legitimate shorter stream. Such a file may be accepted. Do not describe MP3 truncation detection as complete; preserving exact upstream length evidence is required to close this case.

## Legacy staging recovery

Lease-less artifacts written by pre-0062 workers require an explicit drain cutoff before recovery can claim them. Follow the rollout order and risk warning in [Legacy artifact recovery cutoff](../README.md#legacy-artifact-recovery-cutoff): keep the setting absent during mixed-version operation, confirm all old writers are drained, and only then set the epoch-millisecond cutoff. Choosing a cutoff while an old writer is still active can make its live staging row eligible for recovery.

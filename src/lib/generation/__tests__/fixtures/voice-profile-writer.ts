import { processVoiceProfile, type VoiceProfileInput } from "../../voice-profiles";

const encoded = process.argv[2];
if (!encoded) process.exit(2);

async function main(): Promise<void> {
  try {
    const input = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as VoiceProfileInput;
    const profile = await processVoiceProfile(input);
    process.stdout.write(JSON.stringify({ accepted: true, id: profile.id }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      accepted: false,
      code: error && typeof error === "object" && "code" in error ? error.code : "unknown",
    }));
  }
}

void main();

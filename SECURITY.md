# Security Policy

## Aura is a demo

Aura is a **demo and proof of concept**, shared as-is for learning and experimentation. It is not production software, it has not been through a security review, and it comes with **no warranty and no support** of any kind (see the [MIT License](LICENSE)).

The author is **not responsible for how Aura is used**, or for any damage, data loss, privacy breach, or legal consequence that results from running, modifying, or deploying it. You use it entirely at your own risk.

## What you are responsible for

Aura is a meeting assistant. Depending on how you configure it, it can:

- capture your microphone and system audio and transcribe it (locally with Vosk by default, or with Azure Speech if you turn that on);
- send excerpts of the live transcript to the AI services and MCP servers in your meeting profile (GitHub Copilot / GitHub Models and Microsoft Learn by default, plus Work IQ or any other MCP server you add), and to the Microsoft Foundry resource you point the optional decision gate at;
- capture the primary screen and read it with local OCR, if you turn that on (off by default). The recognized text may be sent along with the transcript.

You are responsible for:

- **Consent and compliance.** Getting the consent of everyone who is recorded or transcribed, and following the laws, workplace policies, and data-protection rules that apply to you.
- **Where your data goes.** Choosing which services and MCP servers receive your meeting content, and reading their terms and data handling.
- **Your credentials.** Aura stores its settings, including any MCP server `env` and `headers` values you enter, in a plain-text `settings.json` in the app's user-data folder. Don't put secrets there that you can't afford to leak.

## Reporting a vulnerability

There are no supported versions and no response-time commitment. Only the latest commit on `main` is looked at, on a best-effort basis, and a report may not lead to a fix.

If you still want to report something, please do it privately: open this repository's **Security** tab and choose **Report a vulnerability**. If that isn't available, open an issue asking for a private way to share it, without any technical details.

Please don't post anything in a public issue that could expose other people's data or credentials, and don't include real secrets, tokens, or meeting content in a report.

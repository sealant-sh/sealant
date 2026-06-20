# Sealant Mobile

Expo + React Native mobile app for starting, approving, watching, and reviewing AI coding work from
a phone.

## Development

```bash
pnpm --filter @sealant/mobile start
pnpm --filter @sealant/mobile dev
pnpm --filter @sealant/mobile typecheck
```

Use `dev` with a development build for push notifications and native auth/deep-link flows.

### iOS Simulator

The default `development` EAS profile is for physical devices and requires Apple signing. Build a
simulator app with the simulator-specific profile instead:

```bash
cd apps/mobile
pnpm dlx eas-cli build --platform ios --profile ios-simulator
```

When EAS finishes, accept the prompt to install the build on the running Simulator, or later run:

```bash
cd apps/mobile
pnpm dlx eas-cli build:run --platform ios
```

Then start Metro for the installed development app:

```bash
pnpm --dir apps/mobile exec expo start --dev-client --host localhost --port 8082
```

## Data Modes

Default mode is mock-backed:

```bash
pnpm --filter @sealant/mobile start
```

Live sandbox mode uses the existing control-plane sandbox endpoints and keeps issue workflow data
preview-backed:

```bash
EXPO_PUBLIC_SEALANT_MOBILE_DATA_SOURCE=live \
EXPO_PUBLIC_SEALANT_API_BASE_URL=http://localhost:4000 \
pnpm --filter @sealant/mobile start
```

## Product Stance

This is not a mini dashboard. The app is a mobile control room for secure AI coding work:

- Start issue workflows.
- Approve gated access.
- Watch sandbox progress.
- Review Run Records fast.

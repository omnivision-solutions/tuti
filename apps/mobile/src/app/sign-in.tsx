import { useLocalSearchParams } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/lib/session";
import { CLOUD_SERVER, hostOf, normalizeServer } from "@/lib/server";
import { continueWith, emailSignInLink, finishSignIn, type SignedIn } from "@/lib/sign-in";
import { type Colors, useColors } from "@/lib/theme";

type Busy = "google" | "github" | "email";

// Signed out. `tuti://sign-in?state=…&code=…` links (the emailed link's "Open the app") open this screen with those params.
export default function SignIn() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { signIn } = useSession();
  const link = JSON.stringify(useLocalSearchParams());
  // null: Tuti's cloud; otherwise what's typed in the server field.
  const [typedServer, setTypedServer] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const run = async (what: Busy, work: () => Promise<SignedIn | null | void>) => {
    setBusy(what);
    setError(null);
    try {
      const signedIn = await work();
      if (signedIn) {
        await signIn(signedIn);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    finishSignIn(JSON.parse(link)).then(
      (signedIn) => signedIn && signIn(signedIn),
      (e: Error) => setError(e.message),
    );
  }, [link, signIn]);

  const server = () => {
    const address = typedServer === null ? CLOUD_SERVER : normalizeServer(typedServer);
    if (!address) {
      setError("Enter your server's address, like tuti.example.com.");
    }
    return address;
  };
  const provider = (which: "google" | "github") => () => {
    const address = server();
    if (address) {
      void run(which, () => continueWith(which, address));
    }
  };
  const sendLink = () => {
    const address = server();
    const to = email.trim();
    if (!address) {
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(to)) {
      setError("Enter your email address.");
      return;
    }
    void run("email", async () => {
      await emailSignInLink(address, to);
      setSentTo(to);
    });
  };

  const fieldRadius = Platform.OS === "ios" ? 12 : 24;
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.page }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.screen, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
      >
        <Image source={require("../../assets/icon.png")} style={styles.icon} accessibilityIgnoresInvertColors />
        <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">
          Sign in to Tuti
        </Text>
        <Text style={[styles.lead, { color: colors.muted }]}>Answer your users from anywhere.</Text>

        {typedServer !== null && (
          <TextInput
            value={typedServer}
            onChangeText={setTypedServer}
            placeholder="Server address, like tuti.example.com"
            placeholderTextColor={colors.muted}
            accessibilityLabel="Server address"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            style={[styles.field, { borderRadius: fieldRadius, borderColor: colors.input, backgroundColor: colors.card, color: colors.text }]}
          />
        )}

        <Button colors={colors} onPress={provider("google")} busy={busy === "google"} disabled={!!busy}>
          <Image source={require("../../assets/google.png")} style={styles.logo} />
          <Text style={[styles.label, { color: colors.text }]}>Continue with Google</Text>
        </Button>
        <Button colors={colors} onPress={provider("github")} busy={busy === "github"} disabled={!!busy}>
          <Image source={require("../../assets/github.png")} style={[styles.logo, { tintColor: colors.text }]} />
          <Text style={[styles.label, { color: colors.text }]}>Continue with GitHub</Text>
        </Button>

        <Text style={[styles.or, { color: colors.muted }]}>or</Text>

        {sentTo ? (
          <View style={styles.sent} accessibilityLiveRegion="polite">
            <Text style={[styles.sentText, { color: colors.text }]}>
              If {sentTo} has a Tuti account, a sign-in link is on its way. Open it on this phone.
            </Text>
            <Link colors={colors} onPress={() => setSentTo(null)}>
              Use another address
            </Link>
          </View>
        ) : (
          <>
            <TextInput
              value={email}
              onChangeText={setEmail}
              onSubmitEditing={sendLink}
              placeholder="you@company.com"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Email address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              returnKeyType="send"
              style={[styles.field, { borderRadius: fieldRadius, borderColor: colors.input, backgroundColor: colors.card, color: colors.text }]}
            />
            <Button colors={colors} primary onPress={sendLink} busy={busy === "email"} disabled={!!busy}>
              <Text style={[styles.label, { color: colors.onPrimary }]}>Email me a sign-in link</Text>
            </Button>
          </>
        )}

        {error && (
          <Text style={[styles.error, { color: colors.error }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}

        <View style={styles.spacer} />
        {typedServer === null ? (
          <Link colors={colors} onPress={() => setTypedServer("")}>
            Self-hosted server
          </Link>
        ) : (
          <Link colors={colors} onPress={() => setTypedServer(null)}>
            Use {hostOf(CLOUD_SERVER)} instead
          </Link>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Button({ colors, primary, busy, disabled, onPress, children }: { colors: Colors; primary?: boolean; busy: boolean; disabled: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      android_ripple={{ color: primary ? colors.onSoft : colors.border }}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: colors.primary, borderColor: colors.primary } : { backgroundColor: colors.card, borderColor: colors.border },
        { opacity: Platform.OS === "ios" && pressed ? 0.6 : disabled && !busy ? 0.6 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={primary ? colors.onPrimary : colors.muted} /> : children}
    </Pressable>
  );
}

function Link({ colors, onPress, children }: { colors: Colors; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, alignSelf: "center" })}>
      <Text style={[styles.link, { color: colors.primary }]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, paddingHorizontal: 24, gap: 10, width: "100%", maxWidth: 440, alignSelf: "center" },
  icon: { width: 72, height: 72, borderRadius: 18, alignSelf: "center", marginBottom: 8 },
  title: { fontSize: 24, fontWeight: "700", textAlign: "center", letterSpacing: -0.24 },
  lead: { fontSize: 15, textAlign: "center", marginBottom: 16 },
  button: { height: 48, borderRadius: 24, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, overflow: "hidden" },
  label: { fontSize: 16, fontWeight: "500" },
  logo: { width: 20, height: 20 },
  or: { fontSize: 13, textAlign: "center", marginVertical: 4 },
  field: { height: 48, borderWidth: 1, paddingHorizontal: 16, fontSize: 16 },
  sent: { gap: 10, paddingVertical: 8 },
  sentText: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  error: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  spacer: { flex: 1, minHeight: 24 },
  link: { fontSize: 15, fontWeight: "500" },
});

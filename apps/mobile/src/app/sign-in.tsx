import { useLocalSearchParams } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/lib/session";
import { CLOUD_SERVER, hostOf, normalizeServer, reachable } from "@/lib/server";
import { continueWith, finishSignIn, forgotPasswordUrl, type SignedIn, signInWithPassword } from "@/lib/sign-in";
import { type Colors, useColors } from "@/lib/theme";

/** What's under way: a sign-in started here, or a way back the app was opened with (`return`). */
type Busy = "google" | "github" | "password" | "return";

// Signed out. Google's and GitHub's way back, `tuti://sign-in?state=…&code=…`, opens this screen with those params.
export default function SignIn() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { signIn } = useSession();
  const link = JSON.stringify(useLocalSearchParams());
  // null: Tuti's cloud; otherwise what's typed in the server field.
  const [typedServer, setTypedServer] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const [running, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // A way back the app was opened with (on Android the app can be closed while the browser is open, so nothing here
  // started it): busy until its exchange is done, so no other sign-in starts meanwhile; nothing after the screen's gone.
  const [settledLink, setSettledLink] = useState<string | null>(null);
  const returning = !!(JSON.parse(link) as Record<string, unknown>).state && settledLink !== link;
  useEffect(() => {
    let live = true;
    finishSignIn(JSON.parse(link))
      .then((signedIn) => {
        if (live && signedIn) {
          return signIn(signedIn);
        }
      })
      // Saving the session can fail too, not only the exchange: either is shown.
      .catch((e: unknown) => {
        if (live) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (live) {
          setSettledLink(link);
        }
      });
    return () => {
      live = false;
    };
  }, [link, signIn]);
  const busy: Busy | null = running ?? (returning ? "return" : null);

  // VoiceOver has no live regions: an error is announced (TalkBack reads the live region below).
  useEffect(() => {
    if (error && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(error);
    }
  }, [error]);

  const server = () => {
    const address = typedServer === null ? CLOUD_SERVER : normalizeServer(typedServer);
    if (!address) {
      setError("Enter your server's address, like tuti.example.com.");
      return null;
    }
    if (!reachable(address, __DEV__)) {
      setError("Use your server's https address: the app signs in over https only.");
      return null;
    }
    return address;
  };
  // One sign-in at a time: the keyboard's Go works while the buttons are off.
  const provider = (which: "google" | "github") => () => {
    if (busy) {
      return;
    }
    const address = server();
    if (address) {
      void run(which, () => continueWith(which, address));
    }
  };
  const signInWith = () => {
    if (busy) {
      return;
    }
    const address = server();
    if (!address) {
      return;
    }
    if (!email.trim() || !password) {
      setError("Enter your email address and password.");
      return;
    }
    void run("password", () => signInWithPassword(address, email.trim(), password));
  };
  const forgotPassword = () => {
    const address = server();
    if (address) {
      void openBrowserAsync(forgotPasswordUrl(address));
    }
  };

  const fieldRadius = Platform.OS === "ios" ? 12 : 24;
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.page }} behavior="padding">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.screen, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
      >
        <View style={styles.tile}>
          <Image source={require("../../assets/splash-icon.png")} style={styles.mark} accessibilityIgnoresInvertColors />
        </View>
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

        <Button colors={colors} label="Continue with Google" onPress={provider("google")} busy={busy === "google"} disabled={!!busy}>
          <Image source={require("../../assets/google.png")} style={styles.logo} />
          <Text style={[styles.label, { color: colors.text }]}>Continue with Google</Text>
        </Button>
        <Button colors={colors} label="Continue with GitHub" onPress={provider("github")} busy={busy === "github"} disabled={!!busy}>
          <Image source={require("../../assets/github.png")} style={[styles.logo, { tintColor: colors.text }]} />
          <Text style={[styles.label, { color: colors.text }]}>Continue with GitHub</Text>
        </Button>

        <Text style={[styles.or, { color: colors.muted }]}>or</Text>

        <TextInput
          value={email}
          onChangeText={setEmail}
          onSubmitEditing={() => passwordField.current?.focus()}
          placeholder="you@company.com"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Email"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          returnKeyType="next"
          submitBehavior="submit"
          style={[styles.field, { borderRadius: fieldRadius, borderColor: colors.input, backgroundColor: colors.card, color: colors.text }]}
        />
        <TextInput
          ref={passwordField}
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={signInWith}
          placeholder="Password"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Password"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          style={[styles.field, { borderRadius: fieldRadius, borderColor: colors.input, backgroundColor: colors.card, color: colors.text }]}
        />
        <Button colors={colors} label="Sign in" primary onPress={signInWith} busy={busy === "password"} disabled={!!busy}>
          <Text style={[styles.label, { color: colors.onPrimary }]}>Sign in</Text>
        </Button>
        <Link colors={colors} onPress={forgotPassword}>
          Forgot password?
        </Link>

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

function Button({ colors, label, primary, busy, disabled, onPress, children }: { colors: Colors; label: string; primary?: boolean; busy: boolean; disabled: boolean; onPress: () => void; children: ReactNode }) {
  return (
    // Not `disabled`: a disabled Pressable can't hold focus, so a keyboard or switch-control user would lose their place
    // while the sign-in runs. A press is ignored instead, and accessibilityState says it's off.
    <Pressable
      onPress={() => !disabled && onPress()}
      accessibilityRole="button"
      accessibilityLabel={label}
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
  // The app's icon as the mockups draw it: the mark on a white tile, in both appearances.
  tile: { width: 72, height: 72, borderRadius: 18, backgroundColor: "#ffffff", alignItems: "center", justifyContent: "center", alignSelf: "center", marginBottom: 8, boxShadow: "0 2px 10px rgba(0, 0, 0, 0.12)" },
  mark: { width: 46, height: 46 },
  title: { fontSize: 24, fontWeight: "700", textAlign: "center", letterSpacing: -0.24 },
  lead: { fontSize: 15, textAlign: "center", marginBottom: 16 },
  button: { height: 48, borderRadius: 24, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, overflow: "hidden" },
  label: { fontSize: 16, fontWeight: "500" },
  logo: { width: 20, height: 20 },
  or: { fontSize: 13, textAlign: "center", marginVertical: 4 },
  field: { height: 48, borderWidth: 1, paddingHorizontal: 16, fontSize: 16 },
  error: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  spacer: { flex: 1, minHeight: 24 },
  link: { fontSize: 15, fontWeight: "500" },
});

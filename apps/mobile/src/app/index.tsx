import { Image, StyleSheet, Text, useColorScheme, View } from "react-native";

// The web app's page and text colours (`--background` and `--foreground` in packages/ui/src/globals.css), as hex.
const light = { page: "#fbf9f3", text: "#1c1917" };
const dark = { page: "#0f1411", text: "#f1f5f2" };

export default function Home() {
  const colors = useColorScheme() === "dark" ? dark : light;
  return (
    <View style={[styles.screen, { backgroundColor: colors.page }]}>
      <Image source={require("../../assets/splash-icon.png")} style={styles.mark} accessibilityIgnoresInvertColors />
      <Text style={[styles.name, { color: colors.text }]}>Tuti</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  mark: { width: 96, height: 96 },
  name: { fontSize: 28, fontWeight: "600" },
});

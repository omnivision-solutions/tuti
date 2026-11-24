import { Image, StyleSheet, Text, useColorScheme, View } from "react-native";

// The palette is Tuti's (packages/ui/src/globals.css): warm paper and ink, swapped in the dark.
const paper = "#f8f4f1";
const ink = "#1c1917";

export default function Home() {
  const dark = useColorScheme() === "dark";
  return (
    <View style={[styles.screen, { backgroundColor: dark ? ink : paper }]}>
      <Image source={require("../../assets/splash-icon.png")} style={styles.mark} accessibilityIgnoresInvertColors />
      <Text style={[styles.name, { color: dark ? paper : ink }]}>Tuti</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  mark: { width: 96, height: 96 },
  name: { fontSize: 28, fontWeight: "600" },
});

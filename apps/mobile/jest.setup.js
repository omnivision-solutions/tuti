// Gesture handler's own Jest mocks.
require("react-native-gesture-handler/jestSetup");

// A swipeable row as a plain view with its actions drawn beside it, as if swiped open: Reanimated, which moves it,
// doesn't run under Jest. Swiping is checked on the devices.
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => {
  const React = require("react");
  const { View } = require("react-native");
  const methods = { close() {}, openLeft() {}, openRight() {}, reset() {} };
  return {
    __esModule: true,
    default: ({ ref, children, renderRightActions }) => {
      React.useImperativeHandle(ref, () => methods);
      return React.createElement(View, null, children, renderRightActions?.(null, null, methods));
    },
  };
});

// Expo's SQLite key-value store, in memory: one map per database.
jest.mock("expo-sqlite/kv-store", () => {
  const databases = new Map();
  class SQLiteStorage {
    constructor(name) {
      this.items = databases.get(name) ?? new Map();
      databases.set(name, this.items);
    }
    getItemSync(key) {
      return this.items.get(key) ?? null;
    }
    setItemSync(key, value) {
      this.items.set(key, value);
    }
    removeItemSync(key) {
      return this.items.delete(key);
    }
    clearSync() {
      this.items.clear();
      return true;
    }
    getAllKeysSync() {
      return [...this.items.keys()];
    }
  }
  return { __esModule: true, SQLiteStorage, default: new SQLiteStorage("ExpoSQLiteStorage") };
});

// The window a screen is drawn in: a phone's unless a test says otherwise (`global.mockWindow`, a tablet's to try the
// side-by-side Inbox). React Native's own mock is 750 wide, a tablet's width here.
global.mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({ __esModule: true, default: () => global.mockWindow }));

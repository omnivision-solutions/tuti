// The app's entry: what acts on a notification's Reply and Close is set up before the screens, also in Android's
// background task, which runs this file with no screen.
import "expo-router/entry";

import { startNotificationActions } from "@/lib/notification-actions";

startNotificationActions();

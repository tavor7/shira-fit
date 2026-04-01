import * as Notifications from "expo-notifications";

let inited = false;

export function initNotificationHandler(): void {
  if (inited) return;
  inited = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

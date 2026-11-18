// electron-builder afterSign hook: notarizes the macOS app when the Apple
// credentials are present (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID).
// Without them (local or unsigned CI builds) it does nothing.
exports.default = async function notarize(context) {
    if (context.electronPlatformName !== "darwin") {
        return;
    }
    const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
    if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
        console.log("notarize: skipped (no Apple credentials)");
        return;
    }
    const { notarize } = require("@electron/notarize");
    const appName = context.packager.appInfo.productFilename;
    await notarize({
        appPath: `${context.appOutDir}/${appName}.app`,
        appleId: APPLE_ID,
        appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
        teamId: APPLE_TEAM_ID,
    });
};

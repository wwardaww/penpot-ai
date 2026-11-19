/**
 * Icon set import (W29): GitHub download (allowlisted hosts, limits), archive reading, SVG
 * sanitizing, license detection and the Penpot import scripts. See `wiki/architecture.md` §7.
 */
export { ALLOWED_HOSTS, parseIconSource, type IconSource } from "./IconSource";
export { DEFAULT_ICON_LIMITS, IconImportError, type IconImportErrorCode, type IconLimits } from "./IconLimits";
export { SafeFetch, nodeHttpGet, type HttpAnswer, type HttpGet } from "./SafeFetch";
export { readTar, readTarGz, readZip, type ArchiveEntry, type ArchiveOptions } from "./ArchiveReader";
export { sanitizeSvg, type SanitizedSvg, type SvgRejectReason } from "./SvgSanitizer";
export {
    ICON_ROOT,
    IconCollector,
    detectLicense,
    type CollectedIcon,
    type FoundLicense,
    type IconCollection,
    type SkippedIcon,
} from "./IconCollector";
export { GitHubIcons, type GitHubIconSet } from "./GitHubIcons";
export {
    DEFAULT_ICON_STYLE,
    ICON_COLOR_CANDIDATES,
    ICON_PLUGIN_KEY,
    ICON_TOKEN_SET,
    IconScripts,
    type IconChunkReport,
    type IconStyle,
    type IconTokenReport,
} from "./IconScripts";

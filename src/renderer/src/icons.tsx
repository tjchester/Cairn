import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowBackUp,
  IconBookmark,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconDots,
  IconExternalLink,
  IconFileExport,
  IconFileImport,
  IconFiles,
  IconFilter,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderShare,
  IconFolderX,
  IconInfoCircle,
  IconKeyboard,
  IconLayoutGrid,
  IconLayoutList,
  IconLink,
  IconLinkOff,
  IconLinkPlus,
  IconList,
  IconNote,
  IconPencil,
  IconPhoto,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSortAscending,
  IconSortDescending,
  IconSparkles,
  IconStar,
  IconSunMoon,
  IconTag,
  IconTagOff,
  IconTrash,
  IconTrashX,
  IconWorld,
  IconX,
  type Icon as TablerIcon
} from '@tabler/icons-react'

// Icons come from Tabler Icons (MIT). Each entry is imported by name so the bundler only ships these.
// To use a different set, change this map: the rest of the app refers to icons by the keys below.
const ICONS = {
  bookmark: IconBookmark,
  folder: IconFolder,
  folderOpen: IconFolderOpen,
  addFolder: IconFolderPlus,
  deleteFolder: IconFolderX,
  moveToFolder: IconFolderShare,
  tag: IconTag,
  editTag: IconPencil,
  deleteTag: IconTagOff,
  favorite: IconStar,
  search: IconSearch,
  filter: IconFilter,
  sortAsc: IconSortAscending,
  sortDesc: IconSortDescending,
  add: IconPlus,
  addLink: IconLinkPlus,
  edit: IconPencil,
  remove: IconTrashX,
  trash: IconTrash,
  close: IconX,
  check: IconCheck,
  copy: IconCopy,
  openLink: IconExternalLink,
  link: IconLink,
  unlink: IconLinkOff,
  refresh: IconRefresh,
  import: IconFileImport,
  export: IconFileExport,
  settings: IconSettings,
  theme: IconSunMoon,
  list: IconLayoutList,
  grid: IconLayoutGrid,
  headlines: IconList,
  more: IconDots,
  duplicate: IconFiles,
  warning: IconAlertTriangle,
  error: IconAlertCircle,
  info: IconInfoCircle,
  ok: IconCircleCheck,
  image: IconPhoto,
  note: IconNote,
  keyboard: IconKeyboard,
  undo: IconArrowBackUp,
  web: IconWorld,
  stop: IconPlayerStop,
  sparkles: IconSparkles
} satisfies Record<string, TablerIcon>

export type IconName = keyof typeof ICONS

interface IconProps {
  name: IconName
  size?: number
  color?: string
  className?: string
}

export function Icon({ name, size = 16, color, className }: IconProps): React.JSX.Element {
  const Glyph = ICONS[name]
  return <Glyph size={size} stroke={1.75} color={color} className={`icon${className ? ` ${className}` : ''}`} aria-hidden="true" />
}

import React, { type ReactNode } from 'react';

export type SettingsIconName =
  'subscription' | 'bell' | 'profile' | 'level' | 'theme' | 'coach' | 'about' | 'logout' | 'delete';

const paths: Readonly<Record<SettingsIconName, ReactNode>> = {
  subscription: (
    <React.Fragment>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M3 9.5h18M7 15h4" />
    </React.Fragment>
  ),
  bell: (
    <>
      <path d="M18 9.5a6 6 0 0 0-12 0c0 7-2.5 7-2.5 7h17S18 16.5 18 9.5Z" />
      <path d="M9.5 20h5" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c.8-4 3.3-6 7.5-6s6.7 2 7.5 6" />
    </>
  ),
  level: (
    <>
      <path d="M4 18V9M10 18V5M16 18v-7M22 18V3" />
      <path d="M2.5 21h20" />
    </>
  ),
  theme: <path d="M12 3a9 9 0 1 0 9 9c0-.5 0-.9-.1-1.4A7 7 0 0 1 12 3Z" />,
  coach: (
    <>
      <path d="M4 5.5h16v11H9l-5 4v-15Z" />
      <path d="M8 10h8M8 13h5" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10v6M12 7h.01" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H5v16h5M14 8l4 4-4 4M8 12h10" />
    </>
  ),
  delete: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
    </>
  ),
};

export const SettingsIcon = ({ name }: { readonly name: SettingsIconName }): ReactNode => (
  <svg className="settings-icon" viewBox="0 0 24 24" aria-hidden="true">
    {paths[name]}
  </svg>
);

export const ChevronIcon = (): ReactNode => (
  <svg className="settings-chevron" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m9 5 7 7-7 7" />
  </svg>
);

export const ThemeModeIcon = ({
  mode,
}: {
  readonly mode: 'system' | 'light' | 'dark';
}): ReactNode => {
  if (mode === 'system') {
    return (
      <svg className="settings-theme-mode-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8M12 17v4M12 7a3.5 3.5 0 0 0 0 7Z" />
      </svg>
    );
  }

  if (mode === 'light') {
    return (
      <svg className="settings-theme-mode-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
      </svg>
    );
  }

  return (
    <svg className="settings-theme-mode-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 15.3A8 8 0 0 1 8.7 4 8.5 8.5 0 1 0 20 15.3Z" />
    </svg>
  );
};

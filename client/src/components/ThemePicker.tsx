import { THEMES, setTheme, useTheme } from '../theme'

/** Pick your colour theme (just for you, on every device). */
export function ThemePicker() {
  const theme = useTheme()
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Colour theme">
      {THEMES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} className={`theme-option ${theme === t.id ? 'on' : ''}`} title={t.hint} onClick={() => void setTheme(t.id)}>
          <span className={`theme-swatch ${t.id}`} aria-hidden="true">
            <span />
          </span>
          {t.label}
        </button>
      ))}
    </div>
  )
}

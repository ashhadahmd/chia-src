import type { PickerConfig } from './api'

/* Minimal typings for the parts of the Google Picker API Chia uses. */
interface PickerDoc {
  id: string
}
interface PickerData {
  action: string
  docs?: PickerDoc[]
}
interface PickerBuilder {
  addView(view: unknown): PickerBuilder
  enableFeature(feature: string): PickerBuilder
  setOAuthToken(token: string): PickerBuilder
  setDeveloperKey(key: string): PickerBuilder
  setAppId(id: string): PickerBuilder
  setTitle(title: string): PickerBuilder
  setCallback(cb: (data: PickerData) => void): PickerBuilder
  build(): { setVisible(v: boolean): void }
}
interface PickerNamespace {
  PickerBuilder: new () => PickerBuilder
  DocsView: new (viewId?: string) => { setMimeTypes(m: string): unknown; setIncludeFolders(v: boolean): unknown }
  ViewId: { DOCS: string }
  Feature: { MULTISELECT_ENABLED: string }
  Action: { PICKED: string; CANCEL: string }
}
declare global {
  interface Window {
    gapi?: { load(lib: string, cb: () => void): void }
    google?: { picker?: PickerNamespace }
  }
}

const MIME_TYPES = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/markdown',
  'text/plain',
].join(',')

let loading: Promise<PickerNamespace> | null = null

function loadPicker(): Promise<PickerNamespace> {
  loading ??= new Promise<PickerNamespace>((resolve, reject) => {
    const ready = () => window.gapi!.load('picker', () => resolve(window.google!.picker!))
    if (window.gapi) return ready()
    const script = Object.assign(document.createElement('script'), { src: 'https://apis.google.com/js/api.js', async: true })
    script.onload = ready
    script.onerror = () => {
      loading = null
      reject(new Error('Could not load Google Drive. Check your connection and try again.'))
    }
    document.head.append(script)
  })
  return loading
}

/** Opens Google's Drive picker. Resolves with the chosen file ids ([] when cancelled). */
export async function pickFromDrive(config: PickerConfig): Promise<string[]> {
  const picker = await loadPicker()
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
    view.setMimeTypes(MIME_TYPES)
    view.setIncludeFolders(true)
    new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(config.access_token)
      .setDeveloperKey(config.api_key)
      // The app id grants Chia's drive.file scope access to exactly the files picked.
      .setAppId(config.app_id)
      .setTitle('Import into Chia')
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) resolve((data.docs ?? []).map((d) => d.id))
        else if (data.action === picker.Action.CANCEL) resolve([])
      })
      .build()
      .setVisible(true)
  })
}

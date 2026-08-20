import {
  getIosInstallManifest,
  getIosInstallManifestV1,
} from './generated/sdk.gen.js'

export type GetIosInstallManifestTextOptions = Parameters<
  typeof getIosInstallManifest
>[0]

export type GetIosInstallManifestV1TextOptions = Parameters<
  typeof getIosInstallManifestV1
>[0]

/** Returns the iOS installation manifest as XML text instead of a Blob. */
export const getIosInstallManifestText = async (
  options: GetIosInstallManifestTextOptions,
): Promise<string> =>
  (await getIosInstallManifest({ ...options, parseAs: 'text' })) as unknown as string

/** Returns the legacy iOS installation manifest as XML text instead of a Blob. */
export const getIosInstallManifestV1Text = async (
  options: GetIosInstallManifestV1TextOptions,
): Promise<string> =>
  (await getIosInstallManifestV1({
    ...options,
    parseAs: 'text',
  })) as unknown as string

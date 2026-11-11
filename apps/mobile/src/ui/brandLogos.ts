/**
 * Google's and Microsoft's own logo files, by `BRAND_ICONS` key, and
 * Google's own sign-in buttons. They are drawn as images so that nothing of
 * them is recoloured, redrawn or cropped, which their brand guidelines
 * forbid. apps/web/src/assets/brands/README.md says where each came from.
 */
import type { ImageSourcePropType } from 'react-native'

import gmail from '../../assets/brands/gmail.png'
import google from '../../assets/brands/google.png'
import googlecalendar from '../../assets/brands/googlecalendar.png'
import googledocs from '../../assets/brands/googledocs.png'
import googledrive from '../../assets/brands/googledrive.png'
import googlesheets from '../../assets/brands/googlesheets.png'
import googleslides from '../../assets/brands/googleslides.png'
import googletasks from '../../assets/brands/googletasks.png'
import microsoftexcel from '../../assets/brands/microsoftexcel.png'
import microsoftonedrive from '../../assets/brands/microsoftonedrive.png'
import microsoftoutlook from '../../assets/brands/microsoftoutlook.png'
import microsoftpowerpoint from '../../assets/brands/microsoftpowerpoint.png'
import microsoftword from '../../assets/brands/microsoftword.png'
import signInGoogleDark from '../../assets/brands/signin-google-dark.png'
import signInGoogleIosDark from '../../assets/brands/signin-google-ios-dark.png'
import signInGoogleIosLight from '../../assets/brands/signin-google-ios-light.png'
import signInGoogleLight from '../../assets/brands/signin-google-light.png'

export const BRAND_LOGOS: Record<string, ImageSourcePropType> = {
  gmail,
  google,
  googlecalendar,
  googledocs,
  googledrive,
  googlesheets,
  googleslides,
  googletasks,
  microsoftexcel,
  microsoftonedrive,
  microsoftoutlook,
  microsoftpowerpoint,
  microsoftword
}

/**
 * "Sign in with Google" as Google publishes it: one drawing for iOS, at 188
 * by 44, and one for Android and the web, at 180 by 40, each light and dark.
 */
export const GOOGLE_SIGN_IN = {
  android: { dark: signInGoogleDark, height: 40, light: signInGoogleLight, width: 180 },
  ios: { dark: signInGoogleIosDark, height: 44, light: signInGoogleIosLight, width: 188 }
}

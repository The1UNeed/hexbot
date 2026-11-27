/**
 * Google's and Microsoft's own logo files, by `BRAND_ICONS` key, and their
 * own sign-in buttons. They are drawn as images so that nothing of them is
 * recoloured, redrawn or cropped, which their brand guidelines forbid. The
 * files and where each came from are in src/assets/brands/README.md.
 */
import gmail from '../assets/brands/gmail.svg'
import google from '../assets/brands/google.svg'
import googlecalendar from '../assets/brands/googlecalendar.svg'
import googledocs from '../assets/brands/googledocs.svg'
import googledrive from '../assets/brands/googledrive.svg'
import googlesheets from '../assets/brands/googlesheets.svg'
import googleslides from '../assets/brands/googleslides.svg'
import googletasks from '../assets/brands/googletasks.svg'
import microsoft from '../assets/brands/microsoft.svg'
import microsoftexcel from '../assets/brands/microsoftexcel.svg'
import microsoftonedrive from '../assets/brands/microsoftonedrive.svg'
import microsoftoutlook from '../assets/brands/microsoftoutlook.svg'
import microsoftpowerpoint from '../assets/brands/microsoftpowerpoint.svg'
import microsofttodo from '../assets/brands/microsofttodo.svg'
import microsoftword from '../assets/brands/microsoftword.svg'
import signInGoogleDark from '../assets/brands/signin-google-dark.svg'
import signInGoogleLight from '../assets/brands/signin-google-light.svg'
import signInMicrosoftDark from '../assets/brands/signin-microsoft-dark.svg'
import signInMicrosoftLight from '../assets/brands/signin-microsoft-light.svg'

export const BRAND_LOGOS: Record<string, string> = {
  gmail,
  google,
  googlecalendar,
  googledocs,
  googledrive,
  googlesheets,
  googleslides,
  googletasks,
  microsoft,
  microsoftexcel,
  microsoftonedrive,
  microsoftoutlook,
  microsoftpowerpoint,
  microsofttodo,
  microsoftword
}

/**
 * "Sign in with Google" and "Sign in with Microsoft" as each publishes them
 * for apps, in the light and dark versions both allow, at their own sizes.
 */
export const SIGN_IN_BUTTONS = {
  google: { dark: signInGoogleDark, height: 40, light: signInGoogleLight, width: 180 },
  microsoft: { dark: signInMicrosoftDark, height: 41, light: signInMicrosoftLight, width: 215 }
} as const

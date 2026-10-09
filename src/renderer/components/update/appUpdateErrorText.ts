import {
  APP_UPDATE_DEV_INSTALL_LOCKED_ERROR,
  APP_UPDATE_DEV_OFFLINE_DISALLOWED_ERROR,
  APP_UPDATE_DEV_REVOKED_ERROR,
  APP_UPDATE_DEV_SCOPE_MISMATCH_ERROR,
  APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR,
  APP_UPDATE_DEV_STORE_CORRUPTED_ERROR,
  APP_UPDATE_DEV_UNTRUSTED_ERROR,
  APP_UPDATE_ELEVATION_DECLINED_ERROR,
  APP_UPDATE_FILE_INVALID_ERROR,
  APP_UPDATE_GRAY_UNAVAILABLE_ERROR,
  APP_UPDATE_URL_UNTRUSTED_ERROR,
} from '../../../shared/appUpdate/constants';
import { i18nService } from '../../services/i18n';

/**
 * Maps stable main-process error markers to localized text. Anything else is
 * an OS/network message shown as-is.
 */
export const formatAppUpdateError = (message: string): string => {
  if (message.startsWith(APP_UPDATE_DEV_REVOKED_ERROR)) {
    return i18nService.t('updateDevRevoked');
  }
  if (message.startsWith(APP_UPDATE_DEV_UNTRUSTED_ERROR)) {
    return i18nService.t('updateDevUntrusted');
  }
  if (message.startsWith(APP_UPDATE_DEV_OFFLINE_DISALLOWED_ERROR)) {
    return i18nService.t('updateDevOfflineDisallowed');
  }
  if (message.startsWith(APP_UPDATE_DEV_INSTALL_LOCKED_ERROR)) {
    return i18nService.t('updateDevInstallLocked');
  }
  if (message.startsWith(APP_UPDATE_DEV_SCOPE_MISMATCH_ERROR)) {
    return i18nService.t('updateDevScopeMismatch');
  }
  if (message.startsWith(APP_UPDATE_DEV_STORE_CORRUPTED_ERROR)) {
    return i18nService.t('updateDevStoreCorrupted');
  }
  if (message.startsWith(APP_UPDATE_DEV_SIGNATURE_INVALID_ERROR)) {
    return i18nService.t('updateDevSignatureInvalid');
  }
  if (message === APP_UPDATE_GRAY_UNAVAILABLE_ERROR) {
    return i18nService.t('updateGrayUnavailable');
  }
  if (message === APP_UPDATE_ELEVATION_DECLINED_ERROR) {
    return i18nService.t('updateElevationDeclined');
  }
  if (message === APP_UPDATE_URL_UNTRUSTED_ERROR) {
    return i18nService.t('updateUrlUntrusted');
  }
  if (message === APP_UPDATE_FILE_INVALID_ERROR) {
    return i18nService.t('updateFileInvalid');
  }
  return message;
};

use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::{autoreleasepool, Retained},
    runtime::{Bool, ProtocolObject},
    ClassType,
};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNErrorCode, UNErrorDomain, UNMutableNotificationContent,
    UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

define_class!(
    #[unsafe(super(NSObject))]
    struct YadeNotificationDelegate;

    unsafe impl NSObjectProtocol for YadeNotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for YadeNotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }
    }
);

thread_local! {
    // Центр уведомлений хранит делегат по слабой ссылке.
    static DELEGATE: Retained<YadeNotificationDelegate> =
        unsafe { msg_send![YadeNotificationDelegate::class(), new] };
}

fn is_bundled() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

pub(crate) fn prepare() {
    if is_bundled() {
        DELEGATE.with(|delegate| {
            UNUserNotificationCenter::currentNotificationCenter()
                .setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
        });
    }
}

pub(super) async fn authorize() -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    autoreleasepool(|_| {
        if !is_bundled() {
            return Err("Для системных уведомлений запустите Yade.app".to_string());
        }
        let completion = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let denied = "Разрешите уведомления для Yade в системных настройках macOS";
            let result = if let Some(error) = unsafe { error.as_ref() } {
                let not_allowed = error.code() == UNErrorCode::NotificationsNotAllowed.0
                    && unsafe { UNErrorDomain } == Some(&*error.domain());
                if not_allowed {
                    Err(format!("Запустите Yade из папки «Программы». {denied}"))
                } else {
                    Err(format!(
                        "не удалось включить уведомления: {}",
                        error.localizedDescription()
                    ))
                }
            } else if granted.as_bool() {
                Ok(())
            } else {
                Err(denied.into())
            };
            let _ = sender.try_send(result);
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert,
                &completion,
            );
        Ok(())
    })?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "не удалось получить разрешение на уведомления".to_string())?
}

pub(super) fn show(title: &str, body: &str) {
    autoreleasepool(|_| {
        if !is_bundled() {
            return;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
        let request =
            UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
        let completion = RcBlock::new(|error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                eprintln!(
                    "не удалось показать уведомление: {}",
                    error.localizedDescription()
                );
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    });
}

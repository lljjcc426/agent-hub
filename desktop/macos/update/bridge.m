#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>

@interface RoppoFeed : NSObject <SPUUpdaterDelegate>
@property(nonatomic, copy) NSString *url;
@end
@implementation RoppoFeed
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.url; }
@end

static RoppoFeed *feed;
static SPUStandardUpdaterController *controller;

static napi_value start(napi_env env, napi_callback_info info) {
    napi_value arg;
    size_t argc = 1;
    char url[128];
    size_t length;
    napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
    if (argc != 1 || napi_get_value_string_utf8(env, arg, url, sizeof(url), &length) != napi_ok ||
        length == 0 || length >= sizeof(url) - 1) {
        napi_throw_type_error(env, NULL, "Invalid local feed URL");
        return NULL;
    }
    feed = [RoppoFeed new];
    feed.url = [NSString stringWithUTF8String:url];
    controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO
        updaterDelegate:feed userDriverDelegate:nil];
    NSError *error = nil;
    if (![controller.updater startUpdater:&error]) {
        napi_throw_error(env, NULL, error.localizedDescription.UTF8String ?: "Sparkle failed to start");
    }
    return NULL;
}

static napi_value check(napi_env env, napi_callback_info info) {
    [controller checkForUpdates:nil];
    return NULL;
}

NAPI_MODULE_INIT() {
    napi_property_descriptor methods[] = {
        {"start", NULL, start, NULL, NULL, NULL, napi_default, NULL},
        {"check", NULL, check, NULL, NULL, NULL, napi_default, NULL}
    };
    napi_define_properties(env, exports, 2, methods);
    return exports;
}

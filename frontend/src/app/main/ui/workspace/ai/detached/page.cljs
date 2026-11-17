;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.detached.page
  "Page of the detached chat window (route `penforge-chat`).

  This page bootstraps no workspace and never connects to the daemon:
  it drops the pairing token `window.open` copied from the opener, tells
  the workspace tab that opened it that it is ready, and that tab
  renders the chat on top of it (see `app.main.data.ai.detached`). The
  page itself only shows a waiting message, or, when no workspace tab
  opened it, a hint and a button that closes the window. It offers no
  way into the app, so it can never start a second agent session for
  the file of its opener."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.detached :as detached]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(defn- has-opener?
  []
  (let [opener (.-opener js/window)]
    (and (some? opener) (not (.-closed ^js opener)))))

(mf/defc detached-chat-page*
  []
  (let [opener? (mf/with-memo [] (has-opener?))

        on-close
        (mf/use-fn #(.close js/window))]

    (mf/with-effect []
      (detached/forget-pairing-token!)
      (detached/notify-opener! :ready)
      (let [on-hide #(detached/notify-opener! :unload)]
        (.addEventListener js/window "pagehide" on-hide)
        #(.removeEventListener js/window "pagehide" on-hide)))

    [:main {:class (stl/css :page)
            :data-testid "ai-detached-page"}
     [:section {:class (stl/css :card)}
      [:> text* {:as "h1" :typography t/title-medium :class (stl/css :title)}
       (if opener?
         (tr "penforge.detached.page.waiting")
         (tr "penforge.detached.page.orphan"))]
      (when-not opener?
        [:*
         [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)}
          (tr "penforge.detached.page.orphan-hint")]
         [:> button* {:variant "primary" :on-click on-close}
          (tr "penforge.detached.page.close")]])]]))

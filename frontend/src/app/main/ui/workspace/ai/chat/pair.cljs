;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.chat.pair
  "Pair route (`/#/penforge/pair?token=`): the Penforge daemon prints
  this link; opening it stores the token in this tab and shares it with
  the open Penpot tabs."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.client :as client]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(mf/defc pair-page*
  [{:keys [token]}]
  (let [token (client/parse-pair-input token)

        on-continue
        (mf/use-fn #(st/emit! (rt/nav-root)))]

    (mf/with-effect [token]
      (when (some? token)
        (st/emit! (client/save-token token))
        ;; keep the token out of the history entry
        (dom/replace-history-state! (str (.-pathname js/location)))
        ;; back to the page this tab came from, if any
        (when (> (.-length js/history) 1)
          (st/emit! (rt/nav-back-local)))))

    [:main {:class (stl/css :pair-page)}
     [:section {:class (stl/css :pair-card)}
      [:> text* {:as "h1" :typography t/title-medium :class (stl/css :title)}
       (if token
         (tr "penforge.pair.done")
         (tr "penforge.pair.invalid"))]
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :description)}
       (if token
         (tr "penforge.pair.done-hint")
         (tr "penforge.pair.invalid-hint"))]
      [:> button* {:variant "primary" :on-click on-continue}
       (tr "penforge.pair.continue")]]]))

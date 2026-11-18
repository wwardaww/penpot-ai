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
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn came-from-penpot?
  "True when a Penpot page of this origin linked to the pair route, so
  going back returns to it. A typed or pasted link, or one opened from
  the daemon console, has no referrer: going back there would leave
  Penpot (another site, or a blank page)."
  [referrer origin history-length]
  (boolean
   (and (string? referrer)
        (string? origin)
        (> history-length 1)
        (or (= referrer origin)
            (str/starts-with? referrer (str origin "/"))))))

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
        ;; back to the Penpot page this tab came from, if any
        (when (came-from-penpot? (.-referrer js/document)
                                 (.-origin js/location)
                                 (.-length js/history))
          (st/emit! (rt/nav-back)))))

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

;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.platform-badge
  "Small pill on a dashboard project row that names the platform of the
  project (Web / Mobile). Renders nothing while it is unknown."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:project-platforms
  (l/derived :penforge-project-settings st/state))

(mf/defc platform-badge*
  [{:keys [project-id]}]
  (let [platforms (mf/deref ref:project-platforms)
        platform  (get platforms project-id)]
    (when (and (pf/enabled?) (contains? pf/platforms platform))
      [:> text* {:as "span"
                 :typography t/body-small
                 :class (stl/css-case :badge true
                                      :badge-mobile (= platform :mobile))
                 :data-testid "penforge-platform-badge"}
       (if (= platform :mobile)
         (tr "penforge.platform.mobile")
         (tr "penforge.platform.web"))])))

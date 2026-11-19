;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.devices
  "Device screen catalog: the screen sizes, in CSS points (the
  viewport size a browser reports, physical pixels divided by the
  device pixel ratio), of current phones, tablets and foldables.

  The workspace device picker reads it, and `app.main.constants`
  appends the devices it lacks to the board size presets, so each size
  lives here only once.

  A device has a default size (`:width`/`:height`, the board a pick
  makes) and may have `:states`: the other screens or postures a user
  can lay out on their own board (tablet portrait/landscape, folded and
  unfolded, each screen of a dual-screen device). The first state is
  the default size.

  Sizes marked `uncertain` are for devices out after the data was
  written or never measured in a browser: they use the best known
  value (announced or rumored panel size over the ratio of the closest
  model). Fix them here once a device ships.")

(def groups
  "Picker group order."
  [:phones :tablets :foldables])

(defn- portrait-landscape
  "Tablet states: the default portrait size and its landscape swap."
  [width height]
  [{:state :portrait :width width :height height}
   {:state :landscape :width height :height width}])

(def devices
  [;; --- Phones: Apple
   ;; uncertain: iPhone 18 Pro / Pro Max (fall 2026), sizes of the
   ;; iPhone 17 Pro / Pro Max that they replace.
   {:id :iphone-18-pro-max :name "iPhone 18 Pro Max" :group :phones :width 440 :height 956}
   {:id :iphone-18-pro :name "iPhone 18 Pro" :group :phones :width 402 :height 874}
   ;; uncertain: iPhone 18 (expected early 2027), size of the iPhone 17.
   {:id :iphone-18 :name "iPhone 18" :group :phones :width 402 :height 874}
   {:id :iphone-17-pro-max :name "iPhone 17 Pro Max" :group :phones :width 440 :height 956}
   {:id :iphone-17-pro :name "iPhone 17 Pro" :group :phones :width 402 :height 874}
   {:id :iphone-17 :name "iPhone 17" :group :phones :width 402 :height 874}
   {:id :iphone-air :name "iPhone Air" :group :phones :width 420 :height 912}
   ;; uncertain: iPhone 17e (2026), size of the iPhone 16e.
   {:id :iphone-17e :name "iPhone 17e" :group :phones :width 390 :height 844}
   {:id :iphone-16-pro-max :name "iPhone 16 Pro Max" :group :phones :width 440 :height 956}
   {:id :iphone-16-pro :name "iPhone 16 Pro" :group :phones :width 402 :height 874}
   {:id :iphone-16-plus :name "iPhone 16 Plus" :group :phones :width 430 :height 932}
   {:id :iphone-16 :name "iPhone 16" :group :phones :width 393 :height 852}
   {:id :iphone-16e :name "iPhone 16e" :group :phones :width 390 :height 844}
   {:id :iphone-15 :name "iPhone 15" :group :phones :width 393 :height 852}
   {:id :iphone-14 :name "iPhone 14" :group :phones :width 390 :height 844}
   {:id :iphone-13-mini :name "iPhone 13 Mini" :group :phones :width 375 :height 812}
   {:id :iphone-se :name "iPhone SE (3rd gen)" :group :phones :width 375 :height 667}

   ;; --- Phones: Samsung Galaxy S
   ;; S26 family (2026): same panels as the S25 family, so the same
   ;; ratios; uncertain until measured.
   {:id :galaxy-s26-ultra :name "Galaxy S26 Ultra" :group :phones :width 412 :height 891}
   {:id :galaxy-s26-plus :name "Galaxy S26+" :group :phones :width 384 :height 832}
   {:id :galaxy-s26 :name "Galaxy S26" :group :phones :width 360 :height 780}
   {:id :galaxy-s25-ultra :name "Galaxy S25 Ultra" :group :phones :width 412 :height 891}
   {:id :galaxy-s25-edge :name "Galaxy S25 Edge" :group :phones :width 412 :height 891}
   {:id :galaxy-s25-plus :name "Galaxy S25+" :group :phones :width 384 :height 832}
   {:id :galaxy-s25 :name "Galaxy S25" :group :phones :width 360 :height 780}
   {:id :galaxy-s24-ultra :name "Galaxy S24 Ultra" :group :phones :width 384 :height 824}
   {:id :galaxy-s24 :name "Galaxy S24" :group :phones :width 360 :height 780}

   ;; --- Phones: Samsung Galaxy A
   ;; 1080x2340 panels at a 2.625 ratio (the Android default for this
   ;; density); the display zoom setting can change the reported width.
   {:id :galaxy-a56 :name "Galaxy A56" :group :phones :width 412 :height 891}
   {:id :galaxy-a36 :name "Galaxy A36" :group :phones :width 412 :height 891}
   {:id :galaxy-a16 :name "Galaxy A16" :group :phones :width 412 :height 891}

   ;; --- Phones: Google Pixel
   ;; uncertain: Pixel 10a (2026), panel of the Pixel 10.
   {:id :pixel-10a :name "Pixel 10a" :group :phones :width 412 :height 923}
   {:id :pixel-10-pro-xl :name "Pixel 10 Pro XL" :group :phones :width 414 :height 921}
   {:id :pixel-10-pro :name "Pixel 10 Pro" :group :phones :width 410 :height 914}
   {:id :pixel-10 :name "Pixel 10" :group :phones :width 412 :height 923}
   {:id :pixel-9-pro :name "Pixel 9 Pro" :group :phones :width 410 :height 914}
   {:id :pixel-9 :name "Pixel 9" :group :phones :width 412 :height 923}
   {:id :pixel-8 :name "Pixel 8" :group :phones :width 412 :height 915}

   ;; --- Tablets
   {:id :ipad-pro-13 :name "iPad Pro 13in (M4/M5)" :group :tablets :width 1032 :height 1376
    :states (portrait-landscape 1032 1376)}
   {:id :ipad-pro-11 :name "iPad Pro 11in (M4/M5)" :group :tablets :width 834 :height 1210
    :states (portrait-landscape 834 1210)}
   {:id :ipad-air-13 :name "iPad Air 13in" :group :tablets :width 1024 :height 1366
    :states (portrait-landscape 1024 1366)}
   {:id :ipad-air-11 :name "iPad Air 11in" :group :tablets :width 820 :height 1180
    :states (portrait-landscape 820 1180)}
   {:id :ipad-a16 :name "iPad (A16)" :group :tablets :width 820 :height 1180
    :states (portrait-landscape 820 1180)}
   {:id :ipad-mini :name "iPad mini (A17 Pro)" :group :tablets :width 744 :height 1133
    :states (portrait-landscape 744 1133)}
   ;; Galaxy Tab sizes assume a ratio of 2 (Samsung's tablet default).
   {:id :galaxy-tab-s11-ultra :name "Galaxy Tab S11 Ultra" :group :tablets :width 924 :height 1480
    :states (portrait-landscape 924 1480)}
   {:id :galaxy-tab-s11 :name "Galaxy Tab S11" :group :tablets :width 800 :height 1280
    :states (portrait-landscape 800 1280)}
   {:id :galaxy-tab-s10-fe :name "Galaxy Tab S10 FE" :group :tablets :width 800 :height 1280
    :states (portrait-landscape 800 1280)}
   {:id :pixel-tablet :name "Pixel Tablet" :group :tablets :width 800 :height 1280
    :states (portrait-landscape 800 1280)}

   ;; --- Foldables and dual screens
   ;; uncertain: Z Fold 8 (2026), screens of the Z Fold 7 (cover
   ;; 1080x2520, inner 1968x2184, both at a 2.625 ratio).
   {:id :galaxy-z-fold-8 :name "Galaxy Z Fold 8" :group :foldables :width 412 :height 960
    :states [{:state :folded :width 412 :height 960}
             {:state :unfolded :width 750 :height 832}]}
   {:id :galaxy-z-fold-7 :name "Galaxy Z Fold 7" :group :foldables :width 412 :height 960
    :states [{:state :folded :width 412 :height 960}
             {:state :unfolded :width 750 :height 832}]}
   ;; uncertain: Z Flip 8 (2026), screens of the Z Flip 7 (main
   ;; 1080x2520, cover 948x1048, both at a 2.625 ratio).
   {:id :galaxy-z-flip-8 :name "Galaxy Z Flip 8" :group :foldables :width 412 :height 960
    :states [{:state :unfolded :width 412 :height 960}
             {:state :cover :width 361 :height 399}]}
   {:id :galaxy-z-flip-7 :name "Galaxy Z Flip 7" :group :foldables :width 412 :height 960
    :states [{:state :unfolded :width 412 :height 960}
             {:state :cover :width 361 :height 399}]}
   ;; Pixel 10 Pro Fold: cover 1080x2364, inner 2076x2152, at 2.625.
   {:id :pixel-10-pro-fold :name "Pixel 10 Pro Fold" :group :foldables :width 412 :height 900
    :states [{:state :folded :width 412 :height 900}
             {:state :unfolded :width 791 :height 820}]}
   ;; uncertain: Apple's book-style foldable, which some call the
   ;; "iPhone Duo". Rumored panels: cover 1422x2088, inner
   ;; 2713x1920 (landscape when open), both taken at a ratio of 3.
   {:id :iphone-fold :name "iPhone Fold (Duo)" :group :foldables :width 474 :height 696
    :states [{:state :folded :width 474 :height 696}
             {:state :unfolded :width 904 :height 640}]}
   ;; Surface Duo 2: two 1344x1892 screens at a 2.5 ratio; spanned
   ;; across both screens with the 34 pt hinge in between.
   {:id :surface-duo-2 :name "Surface Duo 2" :group :foldables :width 540 :height 720
    :states [{:state :left-screen :width 540 :height 720}
             {:state :right-screen :width 540 :height 720}
             {:state :spanned :width 1114 :height 720}]}])

(def ^:private devices-by-id
  (into {} (map (juxt :id identity)) devices))

(defn get-device
  [id]
  (get devices-by-id id))

(defn group-devices
  "The devices of `group`, in catalog order."
  [group]
  (filterv #(= group (:group %)) devices))

(defn has-states?
  [device]
  (boolean (seq (:states device))))

(defn board-specs
  "The boards that picking `device` adds, as `{:name :width :height}`
  maps. One board of the default size named after the device; with
  `with-states`, one board per state instead, named
  `<device> / <state label>`. `state-label` maps a state keyword to its
  (translated) label."
  [device with-states state-label]
  (if (and with-states (has-states? device))
    (mapv (fn [{:keys [state width height]}]
            {:name (str (:name device) " / " (state-label state))
             :width width
             :height height})
          (:states device))
    [{:name (:name device)
      :width (:width device)
      :height (:height device)}]))

(def ^:private group-preset-header
  {:phones "PHONES"
   :tablets "TABLETS"
   :foldables "FOLDABLES"})

(defn- state-preset-name
  [state]
  (case state
    :portrait "Portrait"
    :landscape "Landscape"
    :folded "Folded"
    :unfolded "Unfolded"
    :cover "Cover"
    :left-screen "Left screen"
    :right-screen "Right screen"
    :spanned "Spanned"
    (name state)))

(defn size-preset-entries
  "Board size preset entries (the `app.main.constants/size-presets`
  shape: headers without size, then sizes) for the catalog devices
  whose name is not in `known-names`. Foldables add one entry per
  state; tablets only their default (portrait) size, since the preset
  menu swaps orientation on its own."
  [known-names]
  (into []
        (mapcat
         (fn [group]
           (let [entries (->> (group-devices group)
                              (mapcat (fn [device]
                                        (if (= :foldables group)
                                          (board-specs device true state-preset-name)
                                          (board-specs device false state-preset-name))))
                              (remove #(contains? known-names (:name %))))]
             (when (seq entries)
               (cons {:name (group-preset-header group)} entries)))))
        groups))

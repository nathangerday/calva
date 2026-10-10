(ns calva.fmt.split-keypairs-test
  (:require [calva.fmt.split-keypairs :as sut]
            [cljfmt.core :as cljfmt]
            [cljs.test :refer-macros [deftest is testing]]
            [rewrite-clj.node :as n]
            [rewrite-clj.parser :as p]))

(deftest split-pass-matches-cljfmt
  (doseq [text ["{}" "{:a 1 :b 2}" "{:a 1, :b 2,, :c 3}"
                "{#_ :ignored :a #_ 0 1 :b 2}"
                "{:a 1 #_ [:ignored] :b 2}"
                "{#_ :ignored :a 1}"
                "{:a 1 ;; comment\n :b 2\n\n :c 3}"
                "{:a 1 ; comment\r\n :b 2}"
                "#:ns{:a 1 :b {:c 2 :d 3}}"
                "{[:a :b] 1 {:nested 1 :second 2} 3}"
                "'{:a #?(:clj 1 :cljs 2) :b #tag {:c 3 :d 4}}"
                "{:a \"multi\nline\" :b 2}"
                "{:unpaired}" "{:a 1 :unpaired}"]]
    (let [form (p/parse-string-all text)]
      (is (= (n/string (cljfmt/split-keypairs-over-multiple-lines form))
             (n/string (sut/split-keypairs-over-multiple-lines form))) text))))

(deftest complete-formatting-matches-cljfmt
  (doseq [text ["(ns foo (:require [z] [a]))\n{:a 1 :longer {:b 2 :cccc 3}}"
                "(let [a 1 bb 2]\n {:x 1 :yyy [1 2]})"
                "{:a 1\n\n :longer 2 ; comment\n :b {:c 3 :dd 4}}"
                "#:ns{:a \"multi\nline\" :longer 2}\r\n"]
          options [{:split-keypairs-over-multiple-lines? true}
                   {:split-keypairs-over-multiple-lines? true
                    :sort-ns-references? true :normalize-newlines-at-file-end? true
                    :align-map-columns? true :align-form-columns? true}
                   {:split-keypairs-over-multiple-lines? true
                    :align-map-columns? true :blank-lines-separate-alignment? true
                    :max-column-alignment-gap 5 :indentation? false}
                   {:split-keypairs-over-multiple-lines? false}]]
    (is (= (cljfmt/reformat-string text options)
           (sut/reformat-string text options)) (str text " " options))))

(deftest wide-map-split-is-linear
  (let [form (p/parse-string-all
              (str "{" (apply str (repeat 2000 ":a 1 ")) "}"))
        original-tag n/tag
        visits (atom 0)]
    (with-redefs [n/tag (fn [node] (swap! visits inc) (original-tag node))]
      (is (= 1999 (count (filter n/linebreak?
                                (n/children (first (n/children
                                                    (sut/split-keypairs-over-multiple-lines form)))))))))
    (is (< @visits 20000) "Each map child is inspected a bounded number of times")))

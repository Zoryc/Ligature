/**
 * A small hand-written SyncTeX file. `Unit:65781.76` makes one raw unit one PDF point, so the numbers
 * below read directly as PDF coordinates (origin top-left, y down).
 *
 * Page 1, body vbox 72..720 (top..bottom):
 *   line A  hbox main.tex:5   baseline 100, top 92, bottom 102, x 72..540
 *           x(72) l5 -> fixed to l3 | kern [110,120] l3 | x 150 l3 | glue 200 l4 | x 250 l4 |
 *           trailing kern [500,540] + glue 540, l5 -> fixed to l4
 *   line B  hbox intro.tex:9  baseline 112, top 104, bottom 114
 *           x(72) l1 -> fixed to l2 | glue 100 l2 | x 300 l2 | x 320 from article.cls
 *   vertical glue main.tex:30 at 130 (in the vbox)
 *   line C  hbox main.tex:7   baseline 140: void hbox (parindent) l6 [72,87] | x 100 l7 | glue 200 l7 |
 *           x 260 l8 (column 4) | nested hbox l7 [300,340] holding x 310 l7
 * Page 2: one line, main.tex:12, baseline 100.
 */
export const SYNTHETIC = `SyncTeX Version:1
Input:1:/build/src/./main.tex
Input:2:/build/src/chapters/intro.tex
Input:3:/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls
Output:pdf
Magnification:1000
Unit:65781.76
X Offset:0
Y Offset:0
Content:
!300
{1
[1,30:72,720:468,648,0
(1,5:72,100:468,8,2
x1,5:72,100
k1,3:120,100:10
x1,3:150,100
g1,4:200,100
x1,4:250,100
k1,5:540,100:40
g1,5:540,100
)
(2,9:72,112:468,8,2
x2,1:72,112
g2,2:100,112
x2,2:300,112
x3,40:320,112
)
g1,30:72,130
(1,7:72,140:468,8,2
h1,6:72,140:15,0,0
x1,7:100,140
g1,7:200,140
x1,8,4:260,140
(1,7:300,140:40,8,2
x1,7:310,140
)
)
]
!900
}1
{2
[1,30:72,720:468,648,0
(1,12:72,100:468,8,2
x1,12:72,100
g1,12:100,100
)
]
}2
Input:4:/build/src/late.tex
Postamble:
Count:30
!1200
Post scriptum:
`

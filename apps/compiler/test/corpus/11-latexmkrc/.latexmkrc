# Must never run (latexmk -norc).
open(my $fh, '>', '@PWNED_DOT@') and print $fh "pwned by .latexmkrc\n" and close($fh);

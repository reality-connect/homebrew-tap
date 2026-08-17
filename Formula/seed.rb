class Seed < Formula
  desc "Command-line interface for the new-seed project"
  homepage "https://github.com/reality-connect/new-seed"
  version "1.0.0-beta.2"

  if OS.mac?
    if Hardware::CPU.arm?
      url "https://github.com/reality-connect/releases/releases/download/new-seed-v#{version}/cli-darwin-aarch64"
      sha256 "9bd9d7e2913e00e1473026e216d8dc6467b783f19053d74beb3964f07eebcc77"
    else
      url "https://github.com/reality-connect/releases/releases/download/new-seed-v#{version}/cli-darwin-x86_64"
      sha256 "6d891ea21472780481b9cdc54109c61fa3ccba01c6dc79a9c3e14036fdb5cfc7"
    end
  else
    url "https://github.com/reality-connect/releases/releases/download/new-seed-v#{version}/cli-linux-x86_64-gnu"
    sha256 "493250f4bd3414f209c5e9c1cf751dfa0687cc51bdd4e716c0bb851cf834cf33"
  end

  def install
    bin.install File.basename(url) => "seed"
  end
end

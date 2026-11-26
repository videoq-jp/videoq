FROM quay.io/pypa/manylinux_2_28_x86_64@sha256:55a36963bc0504cdf004011001c1072306402f0b8b83be5a5eba7068f93eec53 AS build
COPY inputs /inputs
COPY recipe /recipe
RUN bash /recipe/build.sh
FROM scratch AS artifact
COPY --from=build /out/ /

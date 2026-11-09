# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY mvnw pom.xml ./
COPY .mvn .mvn
RUN chmod +x mvnw && ./mvnw -q -B dependency:go-offline
COPY src src
RUN ./mvnw -q -B package -DskipTests && cp target/rules-java-*.jar /app.jar

FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S pulse && adduser -S pulse -G pulse && apk add --no-cache wget
USER pulse
COPY --from=build /app.jar /app/app.jar
EXPOSE 8082
# Size the heap from the container's memory limit, not the host's.
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
HEALTHCHECK --interval=5s --timeout=3s --retries=24 CMD wget -qO- http://127.0.0.1:8082/actuator/health/readiness || exit 1
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
